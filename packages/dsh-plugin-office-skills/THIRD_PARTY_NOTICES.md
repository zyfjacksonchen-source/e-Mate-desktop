# Third-party notices

This package bundles the following redistributable components:

| Component | Version | License |
|---|---:|---|
| docx | 9.7.1 | MIT |
| pptxgenjs | 4.0.1 | MIT |
| pdf-lib | 1.17.1 | MIT |
| @pdf-lib/fontkit | 1.1.1 | MIT |
| pdf2json | 4.0.3 | Apache-2.0 |
| jszip | 3.10.1 | MIT |
| @xmldom/xmldom | 0.9.11 | MIT |
| Noto Sans SC Variable | 5.3.0 | SIL Open Font License 1.1 |
| terravic/meeting-transcript-summary-skill | 510aab036c6190f3ee547628cb66409def639ac6 | Apache-2.0 |
| OpenAI PDF Skill | 26.905.11957 | MIT declaration in retained upstream plugin manifest |

The exact pdf2json and font license texts are included beside their assets. Transitive JavaScript license texts are included by the repository release SBOM and third-party-license process.

The meeting-summary preset preserves the upstream Skill, references, template and examples from [terravic/meeting-transcript-summary-skill](https://github.com/terravic/meeting-transcript-summary-skill/tree/510aab036c6190f3ee547628cb66409def639ac6). Its complete Apache-2.0 license is included at `skills/meeting-summary/LICENSE`; the upstream tree contains no separate NOTICE file. e-Mate's host guidance and the numeric-line preservation change in the optional cleaner are documented in `SOURCE.md` and in the modified script.

- Word Skill: NousResearch/hermes-agent DOCX v1.1.0 at `9fc80ac70f6b97e36556c33bc4895b75558d4136`, MIT, Copyright (c) 2026 Nous Research. Full license and local changes: `skills/documents/LICENSE`, `skills/documents/UPSTREAM.md`.
