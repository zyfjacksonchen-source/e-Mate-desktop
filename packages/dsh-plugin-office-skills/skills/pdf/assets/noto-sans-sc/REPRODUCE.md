# Reproducing the Regular font asset

`SOURCE.json` fixes the official input URL, input/output hashes and the fontTools 4.59.2 wheel hash. Download and verify those inputs in an isolated development directory. Install that wheel only in the development environment; fontTools is not part of the client runtime.

With the original file saved as `NotoSansSC-VF.ttf`, run:

```python
from hashlib import sha256
from pathlib import Path
import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

assert fontTools.version == '4.59.2'
source = Path('NotoSansSC-VF.ttf')
assert sha256(source.read_bytes()).hexdigest() == 'd68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964'
font = TTFont(source, recalcTimestamp=False)
regular = instantiateVariableFont(font, {'wght': 400}, inplace=False,
                                 optimize=True, updateFontNames=True)
assert 'fvar' not in regular and 'gvar' not in regular
assert regular['OS/2'].usWeightClass == 400
output = Path('NotoSansSC-Regular.ttf')
regular.save(output, reorderTables=True)
assert sha256(output.read_bytes()).hexdigest() == 'c7763f454946833081cc90e73186615f8e1189de9c5e5a5a8752871fd79fddbc'
```

Preserve `OFL.txt` and `FONT-NOTICE.txt` with the output. The reserved font name is `Source`; the modified font's primary name is Noto Sans SC Regular. Registration and use in ReportLab require only the resulting static TTF, not fontTools or the variable source. The font does not cover every Unicode character; check the actual document's text before delivery.
