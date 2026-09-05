"""Read-only pixel checks for already-generated art. Requires bundled Pillow.
Does not create, tile, transform, repair or approve visual semantics.
Standard hatch-pet atlas/despill and independent visual QA remain mandatory.
"""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / 'assets'
Image.MAX_IMAGE_PIXELS = 12_000_000

def inspect(name, counts):
    with Image.open(root / name) as source:
        if source.format != 'WEBP' or getattr(source, 'n_frames', 1) != 1:
            raise ValueError(name + ': expected one static WebP')
        image = source.convert('RGBA')
    if image.size != (1536, len(counts) * 208):
        raise ValueError(name + ': invalid geometry')
    rows = []
    for row, count in enumerate(counts):
        hashes = []
        for column in range(8):
            cell = image.crop((column * 192, row * 208, (column + 1) * 192, (row + 1) * 208))
            alpha = cell.getchannel('A')
            box = alpha.getbbox()
            if column >= count:
                if box is not None:
                    raise ValueError(f'{name}: unused cell {row}/{column} is not transparent')
                continue
            if box is None:
                raise ValueError(f'{name}: used cell {row}/{column} is empty')
            if box[0] == 0 or box[1] == 0 or box[2] == 192 or box[3] == 208:
                raise ValueError(f'{name}: cell {row}/{column} touches its border')
            hashes.append(hashlib.sha256(cell.tobytes()).hexdigest())
        if len(set(hashes)) < min(3, count):
            raise ValueError(f'{name}: row {row} repeats a static frame')
        rows.append(hashes)
    if len({tuple(row) for row in rows}) != len(rows):
        raise ValueError(name + ': duplicate animation rows')
    return {'file': name, 'sha256': hashlib.sha256((root / name).read_bytes()).hexdigest(), 'rows': len(counts), 'cellPixelHashes': rows}

result = {
    'pixelValidation': 'valid',
    'standard': inspect('xiaoxin-v2.webp', [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]),
    'office': inspect('xiaoxin-office.webp', [8] * 30),
    'semanticAcceptance': 'requires-independent-visual-review',
}
print(json.dumps(result, ensure_ascii=False))
