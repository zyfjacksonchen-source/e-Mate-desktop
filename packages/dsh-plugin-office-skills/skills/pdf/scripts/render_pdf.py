#!/usr/bin/env python3
"""Render PDF pages with public pypdfium2/PDFium; e-Mate, MIT licensed."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_PAGES = 200
MAX_PAGE_PIXELS = 16_000_000
MAX_TOTAL_PIXELS = 100_000_000


def render_pdf(source: Path, output: Path, dpi: int = 144) -> dict:
    """Create a new output directory; return success only after all pages save."""
    if not isinstance(dpi, int) or not 36 <= dpi <= 300:
        raise ValueError("DPI must be an integer from 36 to 300")
    source = source.resolve(strict=True)
    if not source.is_file() or not 0 < source.stat().st_size <= MAX_INPUT_BYTES:
        raise ValueError("PDF input must be a nonempty file no larger than 64 MiB")
    # Existing directories, including empty directories and symlinks, are rejected.
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("Output path already exists; choose a new directory")
    import pypdfium2 as pdfium

    created = False
    owned = []
    try:
        with pdfium.PdfDocument(source) as document:
            document.init_forms()
            count = len(document)
            if not 1 <= count <= MAX_PAGES:
                raise ValueError("PDF must contain between 1 and 200 pages")
            scale = dpi / 72
            sizes = []
            pixels = 0
            # Check all page bitmap sizes before writing anything.
            for index in range(count):
                page = document[index]
                try:
                    width, height = page.get_size()
                    if not all(math.isfinite(n) and n > 0 for n in (width, height)):
                        raise ValueError("Invalid PDF page dimensions")
                    size = math.ceil(width * scale), math.ceil(height * scale)
                    page_pixels = size[0] * size[1]
                    pixels += page_pixels
                    if page_pixels > MAX_PAGE_PIXELS or pixels > MAX_TOTAL_PIXELS:
                        raise ValueError("PDF raster exceeds per-page or total pixel limit")
                    sizes.append(size)
                finally:
                    page.close()
            output.mkdir(mode=0o700, exist_ok=False)
            created = True
            pages = []
            for index, expected in enumerate(sizes):
                page = document[index]
                bitmap = None
                image = None
                try:
                    bitmap = page.render(scale=scale, draw_annots=True)
                    image = bitmap.to_pil()
                    if image.size != expected:
                        raise ValueError("Rendered page dimensions differ from checked dimensions")
                    target = output / f"page-{index + 1:04d}.png"
                    with target.open("xb") as stream:
                        owned.append(target)
                        image.save(stream, format="PNG")
                    pages.append({"page": index + 1, "width": image.width,
                                  "height": image.height, "path": str(target)})
                finally:
                    if image is not None:
                        image.close()
                    if bitmap is not None:
                        bitmap.close()
                    page.close()
        receipt = {"ok": True, "renderer": "pypdfium2",
                   "renderer_version": str(pdfium.PYPDFIUM_INFO),
                   "input": str(source), "output_dir": str(output),
                   "dpi": dpi, "page_count": count, "pages": pages}
        receipt_path = output / "render.json"
        with receipt_path.open("x", encoding="utf-8") as stream:
            owned.append(receipt_path)
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        return receipt
    except BaseException:
        # Remove only files created by this invocation; never recurse over content.
        for path in reversed(owned):
            try:
                path.unlink()
            except OSError:
                pass
        if created:
            try:
                output.rmdir()
            except OSError:
                pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="PDF source file")
    parser.add_argument("output", type=Path, help="new output directory (must not exist)")
    parser.add_argument("--dpi", type=int, default=144)
    args = parser.parse_args()
    try:
        receipt = render_pdf(args.input, args.output, args.dpi)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(receipt, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
