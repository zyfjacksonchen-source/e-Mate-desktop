# PDF and spreadsheet Python dependencies

These requirements are fixed official PyPI wheels for the existing CPython 3.12.14 bootstrap. Each URL has a SHA-256 digest; installation uses binary wheels, no dependency resolution, and a staging directory. Package metadata, exact versions and license-file names are recorded in `manifest.json`. Preserve all wheel `dist-info` licenses and the PDFium dependency license directories in distributed runtime bytes.

The selected pypdfium2 5.11.0 supports the product's existing macOS 12 minimum on both architectures. 5.12.1 and 5.13.0 require macOS 13; 5.12.0 has no usable Mac wheels. cryptography 48.0.1 preserves the Mac x64 wheel path absent from 50.0.1. These choices do not raise the application's minimum OS requirement. Runtime tests remain necessary; metadata compatibility is not execution evidence.

Top-level dependencies are reportlab 4.4.9 (BSD), pypdf 6.10.0 (BSD-3-Clause), pdfplumber 0.11.9 (MIT), openpyxl 3.1.5 (MIT), Pillow 12.3.0 (MIT-CMU), and pypdfium2 5.11.0 (BSD-3-Clause / Apache-2.0 and bundled dependency licenses). Transitive notices remain in the original distributions. PDFium includes additional component notices and CC-BY-4.0 material; do not replace those directories with only the wrapper's BSD notice.

No Codex private runtime, artifact-tool, PyMuPDF, Hermes runtime, python-docx or lxml is included by these requirements. Word uses the existing TypeScript implementation. openpyxl does not calculate formulas or render spreadsheets; those acceptance gates remain separate.
