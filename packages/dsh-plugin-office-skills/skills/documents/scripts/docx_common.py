#!/usr/bin/env python3
# MIT License. Shared helpers for the docx skill scripts.
"""Shared helpers: paragraph iteration and run-preserving text replacement."""
from __future__ import annotations


def iter_all_paragraphs(doc, include_headers_footers: bool = True):
    """Yield every paragraph in body, tables (recursively), headers, footers."""
    seen = set()
    def unique(container):
        for paragraph in _iter_container(container):
            if paragraph._p not in seen:
                seen.add(paragraph._p)
                yield paragraph
    yield from unique(doc)
    if include_headers_footers:
        for section in doc.sections:
            for part in (
                section.header, section.footer,
                section.first_page_header, section.first_page_footer,
                section.even_page_header, section.even_page_footer,
            ):
                if part is not None:
                    yield from unique(part)


def _iter_container(container):
    for para in container.paragraphs:
        yield para
    for table in container.tables:
        yield from _iter_table(table)


def _iter_table(table):
    for row in table.rows:
        for cell in row.cells:
            for para in cell.paragraphs:
                yield para
            for nested in cell.tables:
                yield from _iter_table(nested)


def iter_part_roots(doc):
    """Yield the XML root of the body plus every header/footer part."""
    yield doc.element.body
    seen = set()
    for section in doc.sections:
        for part in (
            section.header, section.footer,
            section.first_page_header, section.first_page_footer,
            section.even_page_header, section.even_page_footer,
        ):
            if part is not None and id(part._element) not in seen:
                seen.add(id(part._element))
                yield part._element


def replace_in_paragraph(para, old: str, new: str) -> int:
    """Replace `old` with `new` in a paragraph, preserving run formatting.

    Strategy: first replace occurrences fully contained in a single run
    (formatting fully preserved). If the needle spans multiple runs, the
    matched runs are collapsed: the replacement inherits the formatting of
    the run where the match starts. Returns number of replacements made.
    """
    if not old or old not in para.text:
        return 0
    runs = para.runs
    full = "".join(r.text for r in runs)
    matches = []
    cursor = 0
    while True:
        start = full.find(old, cursor)
        if start < 0:
            break
        matches.append((start, start + len(old)))
        cursor = start + len(old)
    offsets = []
    cursor = 0
    for run in runs:
        offsets.append((cursor, cursor + len(run.text)))
        cursor += len(run.text)
    # Work backwards against original offsets; never scan inserted text.
    for start, end in reversed(matches):
        first = True
        for run, (left, right) in zip(runs, offsets):
            if right <= start or left >= end:
                continue
            cut_start, cut_end = max(start, left) - left, min(end, right) - left
            text = run.text
            run.text = text[:cut_start] + (new if first else "") + text[cut_end:]
            first = False
    return len(matches)
