# Source and licensing record

The adapter and normalized Office contracts are original e-Mate MIT code. No Codex runtime, Microsoft Office, LibreOffice, Python worker, or old e-Mate Office plugin code is copied.

Exact distributable dependencies:

- docx 9.7.1 — MIT
- XLSX is implemented directly with the bundled JSZip and XML primitives; no spreadsheet runtime dependency is added.
- pptxgenjs 4.0.1 — MIT
- pdf-lib 1.17.1 and @pdf-lib/fontkit 1.1.1 — MIT
- pdf2json 4.0.3 — Apache-2.0; its published single-file ESM is copied unchanged into `assets/pdf2json/`
- jszip 3.10.1 — used under MIT
- @xmldom/xmldom 0.9.11 — MIT
- Noto Sans SC Variable 5.3.0 font assets — SIL Open Font License 1.1

The runtime targets DeepSeek Harness 0.1.0-rc.7 Tool, Job, Skill, and capability seams. Unsupported layout-preserving edits are an explicit product boundary, not a hidden system dependency.

## Meeting summary preset

- Source: https://github.com/terravic/meeting-transcript-summary-skill
- Fixed commit: `510aab036c6190f3ee547628cb66409def639ac6`
- License: Apache-2.0, preserved in `skills/meeting-summary/LICENSE`.
- Original Skill name: `meeting-transcript-summary`; local provider identifier: `meeting-summary`, Chinese discovery description: “会议总结”. No additional Tool is registered.
- Original `SKILL.md` bytes are unchanged (SHA-256 `852f8724aafd16de632326fb7aa12437bf8129b919f80180de71e216902694ca`); its three references, HTML template and examples are preserved. The source README and explanatory screenshots are not required by the Skill entry and are omitted.
- e-Mate additions: `HOST.md` is prepended by the existing provider with the actual absolute resource directory. It retains the original transcript as authority, makes cleaning optional, uses only existing native Python if available, and does not claim audio transcription or require a connection.
- e-Mate script change (2026-09-07): `clean_transcript.py` now drops an all-digit line only when immediately followed by a subtitle timestamp. Standalone numeric meeting facts survive. All other upstream cleanup behavior remains; timestamps are still removed from the optional derivative, so citations and facts must be checked against the untouched original.
- The helper requires only Python standard-library modules; no Python dependency or runtime is bundled by this addition. The Agent performs synthesis through its existing model channel. The original four Office presets and two Tool/Job paths remain available while their replacements are prepared.

## Word TypeScript workflow

- Uses the existing pinned `dolanmiu/docx` 9.7.1 MIT dependency and native e-Mate Tool/Job/attachment paths. The documents Skill is an e-Mate workflow, not a claimed upstream Skill release.
- The Python Hermes subtree and Word-only Python wheel installation were removed in favor of TypeScript creation, template filling and text replacement. Historical provenance and test receipts remain in Git and private evidence.
- Visual pagination acceptance and complex edit coverage remain separate from package correctness; see `skills/documents/UPSTREAM.md`.

## Codex PDF replacement

- OpenAI PDF plugin `26.905.11957`; its original four Skill files are retained byte-for-byte. Exact file hashes, the original MIT plugin manifest and the licensing inspection scope are recorded in `skills/pdf/SOURCE.md` and `skills/pdf/UPSTREAM.json`.
- `HOST.md` maps resource paths, the native Python environment and real attachment delivery to e-Mate. The marker helper only checks its arguments; it is not evidence of successful generation or rendering.
- Python dependencies and a real renderer remain a separate acceptance gate. The provider reports `needs-runtime` until that gate is verified.
- e-Mate adds `scripts/render_pdf.py` and `references/rendering.md` using publicly distributed pypdfium2/PDFium. Rendering tests use real PDFs and PNGs; the original four upstream Skill files remain unchanged. Packaged dependency verification is separate.

## Codex Spreadsheets replacement

- OpenAI Spreadsheets plugin `26.905.11957`; original 19 Skill files are retained byte-for-byte. Original MIT plugin declaration and hashes: `skills/spreadsheets/UPSTREAM.json`.
- The original Skill explicitly permits openpyxl when artifact-tool is unavailable. HOST selects that supported path; the proprietary artifact-tool runtime is not distributed.
- Formula recalculation and rendering need actual supporting runtime and receipts; openpyxl alone does not establish either. Provider readiness remains pending.
