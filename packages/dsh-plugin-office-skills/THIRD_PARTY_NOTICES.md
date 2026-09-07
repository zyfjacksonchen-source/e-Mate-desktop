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
| hugohe3/ppt-master | c45b7427e707d8695f1bf7df4d20360d05f82e7c | MIT; bundled assets retain their own notices |

The exact pdf2json and font license texts are included beside their assets. Transitive JavaScript license texts are included by the repository release SBOM and third-party-license process.

The meeting-summary preset preserves the upstream Skill, references, template and examples from [terravic/meeting-transcript-summary-skill](https://github.com/terravic/meeting-transcript-summary-skill/tree/510aab036c6190f3ee547628cb66409def639ac6). Its complete Apache-2.0 license is included at `skills/meeting-summary/LICENSE`; the upstream tree contains no separate NOTICE file. e-Mate's host guidance and the numeric-line preservation change in the optional cleaner are documented in `SOURCE.md` and in the modified script.


The Word workflow uses the existing MIT docx dependency. The Hermes Python Skill is no longer included.

PPT Master retains its original license and attribution guard under `skills/ppt-master`. Its icon, audio and geometry assets retain their upstream notices; see `skills/ppt-master/SOURCE.md` for the source manifest and adapted document references. No PyMuPDF runtime is distributed.

The OpenAI Spreadsheets Skill 26.905.11957 retains its original MIT plugin manifest at `skills/spreadsheets/UPSTREAM_PLUGIN_MANIFEST.json`. No artifact-tool runtime is included.
