"""Compute XLSX caches using the managed formulas engine; never rewrite via ExcelModel.write.

The native Office owner validates/bounds the ZIP, snapshots it and confines this process.
No external workbooks, model pickle, custom functions or formula interpreter are loaded.
"""
import math
import posixpath
import sys
import zipfile
from pathlib import Path

import formulas
from formulas.ranges import Ranges
from formulas.tokens.operand import XlError
from lxml import etree
from openpyxl.utils.cell import coordinate_to_tuple

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
TAG = '{' + NS['s'] + '}'


def xml(data):
    return etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))


def calculate(source, destination):
    if source.resolve() == destination.resolve():
        raise ValueError('Source must not be overwritten')
    with zipfile.ZipFile(source) as archive:
        relations = {r.get('Id'): r for r in xml(archive.read('xl/_rels/workbook.xml.rels'))}
        worksheets = {}
        expected = {}
        for sheet in xml(archive.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS):
            rel = relations[sheet.get(REL)]
            if rel.get('TargetMode', '').lower() == 'external':
                raise ValueError('External worksheet is unsupported')
            target = rel.get('Target', '')
            part = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
            if not part.startswith('xl/') or '\\' in part:
                raise ValueError('Invalid worksheet relationship')
            # Chartsheets contain no cells; preserve them without asking the engine to calculate them.
            if not rel.get('Type', '').endswith('/worksheet'):
                continue
            title = sheet.get('name').upper()
            tree = xml(archive.read(part))
            max_row = max_col = 0
            for cell in tree.findall('s:sheetData/s:row/s:c', NS):
                row, col = coordinate_to_tuple(cell.get('r'))
                max_row, max_col = max(max_row, row), max(max_col, col)
                formula = cell.find('s:f', NS)
                if formula is not None:
                    if formula.get('t', 'normal') != 'normal' or formula.get('ref'):
                        raise ValueError('Shared, array and data-table formulas are unsupported')
                    expected[(title, cell.get('r'))] = formula.text
            if max_row * max_col > 1_000_000 or len(expected) > 10_000:
                raise ValueError('Workbook calculation cell quota exceeded')
            worksheets[part] = (title, tree)

        values = {}
        if expected:
            model = formulas.ExcelModel().loads(str(source)).finish(complete=False, circular=False)
            nodes = {}
            # Reference identity comes from the engine's parser, not a parallel formula grammar.
            for key in model.dsp.data_nodes:
                if not isinstance(key, str):
                    continue
                try:
                    reference = Ranges().push(key).ranges[0]
                except formulas.errors.InvalidRangeName:
                    continue
                if (reference.get('filename', '').casefold() != source.name.casefold()
                        or reference.get('directory')):
                    raise ValueError('External workbook reference is unsupported')
                nodes[(reference['sheet'].upper(), reference['ref'])] = key
            solution = model.calculate()
            for address in expected:
                key = nodes.get(address)
                if key is None or key not in solution:
                    raise ValueError('Unresolved formula or circular dependency at ' + '!'.join(address))
                result = solution[key].value
                if result.shape != (1, 1):
                    raise ValueError('Non-scalar formula result is unsupported')
                value = result[0, 0]
                if isinstance(value, XlError):
                    raise ValueError('Formula error at ' + '!'.join(address) + ': ' + str(value))
                if hasattr(value, 'item'):
                    value = value.item()
                if (not isinstance(value, (str, int, float, bool))
                        or isinstance(value, float) and not math.isfinite(value)):
                    raise ValueError('Invalid calculated value')
                values[address] = value

        # Preserve original OOXML relationships, formula nodes, styles, images and other parts.
        # lxml retains namespace declarations (including markup compatibility prefix bindings).
        with zipfile.ZipFile(destination, 'x') as output:
            for item in archive.infolist():
                data = archive.read(item.filename)
                if item.filename in worksheets:
                    title, tree = worksheets[item.filename]
                    changed = False
                    for cell in tree.findall('s:sheetData/s:row/s:c', NS):
                        if cell.find('s:f', NS) is None:
                            continue
                        value = values[(title, cell.get('r'))]
                        cached = cell.find('s:v', NS)
                        if cached is None:
                            cached = etree.Element(TAG + 'v')
                            cell.insert(cell.index(cell.find('s:f', NS)) + 1, cached)
                        cell.set('t', 'b' if isinstance(value, bool) else 'str' if isinstance(value, str) else 'n')
                        cached.text = str(int(value)) if isinstance(value, bool) else str(value)
                        changed = True
                    if changed:
                        data = etree.tostring(tree, encoding='utf-8', xml_declaration=True)
                output.writestr(item, data)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Expected input.xlsx and new output.xlsx')
        calculate(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        print('Workbook recalculation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
