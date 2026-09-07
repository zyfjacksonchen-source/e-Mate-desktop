#!/usr/bin/env python3
"""Bounded native preview adapter. Fixed upstream helpers only; no server or source writes."""
import base64
import contextlib
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import unicodedata
from xml.etree import ElementTree as ET

LIMIT = 32 * 1024 * 1024
SVG = '{http://www.w3.org/2000/svg}'


def run(request):
    scripts = Path(__file__).resolve().parents[1] / 'skills/ppt-master/scripts'
    sys.path.insert(0, str(scripts))
    sys.path.insert(0, str(scripts / 'svg_editor'))
    from annotations import assign_temp_ids, set_annotation, set_text
    from svg_finalize.embed_icons import process_svg_file
    from svg_to_pptx.geometry_properties import materialize_inline_geometry_properties
    from svg_to_pptx.canvas_contract import parse_project_svg_root

    project = Path(request['project']).resolve(strict=True)
    page = request['page']
    if not isinstance(page, str) or not page.endswith('.svg') or not page[:-4] or any(
            c not in '_ .()-' and unicodedata.category(c)[0] not in 'LNM' for c in page[:-4]):
        raise ValueError('Invalid slide filename')
    dependencies = {}
    total = 0

    def read(path):
        nonlocal total
        requested = Path(os.path.abspath(path))
        path = requested.resolve(strict=True)
        if not path.is_relative_to(project) or not path.is_file():
            raise ValueError('Slide resource is outside the project')
        if path.stat().st_size > LIMIT:
            raise ValueError('Slide resource exceeds limit')
        data = path.read_bytes()
        total += len(data)
        if total > LIMIT:
            raise ValueError('Slide resources exceed limit')
        dependencies[str(requested.relative_to(project))] = hashlib.sha256(data).hexdigest()
        return data

    source_path = project / 'svg_output' / page
    source = read(source_path)
    if b'<!DOCTYPE' in source.upper() or b'<!ENTITY' in source.upper():
        raise ValueError('XML declarations are unsupported')
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    root = ET.fromstring(source)
    canvas = parse_project_svg_root(root, context=page)
    existing_ids = [element.get('id') for element in root.iter() if element.get('id')]
    if len(existing_ids) != len(set(existing_ids)):
        raise ValueError('Duplicate slide element IDs are ambiguous')
    assign_temp_ids(root)
    elements = []
    for element in root.iter():
        tag = element.tag.removeprefix(SVG)
        if element.get('id'):
            elements.append({'id': element.get('id'), 'tag': tag,
                             'text': element.text or '' if tag in ('text', 'tspan') else '',
                             'editable': tag in ('text', 'tspan') and not any(c.tag == SVG + 'tspan' for c in element),
                             'annotation': element.get('data-edit-annotation', '')})
    if len(elements) > 2000:
        raise ValueError('Slide has too many editable elements')
    if request.get('change') is not None:
        change = request['change']
        if not any(e['id'] == change['element_id'] for e in elements):
            raise ValueError('Slide element no longer exists')
        value = change['value']
        if not isinstance(value, str) or len(value) > 10000:
            raise ValueError('Invalid edit text')
        if change['kind'] == 'text':
            if not any(e['id'] == change['element_id'] and e['editable'] for e in elements):
                raise ValueError('Select a text or tspan element')
            ok, reason = set_text(root, change['element_id'], value)
            if not ok:
                raise ValueError(reason)
        elif change['kind'] == 'annotation':
            if not value.strip() or not set_annotation(root, change['element_id'], value):
                raise ValueError('Invalid annotation')
        else:
            raise ValueError('Unsupported edit')
        return {'source_hash': hashlib.sha256(source).hexdigest(), 'content': ET.tostring(root, encoding='unicode')}

    # Materialize only in a temporary preview copy. Validate each referenced
    # resource before a fixed upstream helper can read it; never fetch URLs.
    materialize_inline_geometry_properties(root)
    icon_files = {}
    for element in root.iter():
        icon = element.get('data-icon')
        if icon:
            if not re.fullmatch(r'[a-z0-9-]+/[A-Za-z0-9][A-Za-z0-9._-]*', icon):
                raise ValueError('Invalid icon reference')
            icon_files[icon] = read(project / 'icons' / (icon + '.svg'))
        for attr in ('href', '{http://www.w3.org/1999/xlink}href'):
            href = element.get(attr)
            if not href or href.startswith('#') or href.startswith('data:'):
                continue
            if element.tag != SVG + 'image' or ':' in href or '\\' in href:
                raise ValueError('Unsupported external slide reference')
            resource = source_path.parent / href
            ext = resource.suffix.lower()
            mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'}.get(ext)
            if not mime:
                raise ValueError('Preview supports local raster images only')
            element.set(attr, 'data:' + mime + ';base64,' + base64.b64encode(read(resource)).decode('ascii'))
    with tempfile.TemporaryDirectory(prefix='page-', dir=request['temporary']) as temporary:
        directory = Path(temporary)
        for name, data in icon_files.items():
            target = directory / 'icons' / (name + '.svg')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        target = directory / 'preview.svg'
        target.write_text(ET.tostring(root, encoding='unicode'), encoding='utf-8')
        process_svg_file(target, directory / 'icons')
        prepared = target.read_text(encoding='utf-8')
    revision = hashlib.sha256(json.dumps(dependencies, sort_keys=True).encode()).hexdigest()
    return {'source_hash': hashlib.sha256(source).hexdigest(), 'revision': revision,
            'width': math.ceil(float(canvas.width)), 'height': math.ceil(float(canvas.height)),
            'elements': elements, 'svg': prepared, 'dependencies': dependencies}


if __name__ == '__main__':
    try:
        payload = json.loads(sys.stdin.read(LIMIT + 1))
        with contextlib.redirect_stdout(io.StringIO()):
            result = run(payload)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
