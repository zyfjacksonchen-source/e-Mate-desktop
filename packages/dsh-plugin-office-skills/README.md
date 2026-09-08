# @e-mate/dsh-plugin-office-skills

Office support for e-Mate 2.0.18 on the pinned Harness rc.7 Profile.

The native Skill provider exposes `documents`, `pdf`, `spreadsheets`, `ppt-master`, `meeting-summary`, and `lieflat-charts`. Each upstream preset retains its source and license records under its Skill directory; e-Mate's `HOST.md` supplies the actual resource path and native task integration. The old `presentations` preset has been removed.

- `office_read` reads a workspace-relative DOCX, XLSX, PPTX, or PDF into bounded normalized JSON.
- `office_write` creates a new real DOCX, XLSX, PPTX, or PDF under `.e-mate/office/`.
- Every operation uses the target Tool and Job registries. Outputs never overwrite a source file.
- These two Tools use the bundled JavaScript execution closure and an OFL Chinese font. Word creation, template filling and targeted text replacement use the existing TypeScript `docx` implementation.

The PDF, spreadsheet and PPT Master Skill workflows have additional runtime requirements beyond these two Tools. PDF and spreadsheet Python dependencies are prepared by the existing Desktop owner and exposed through `DSH_EMATE_PYTHON`; PPT Master runtime integration is still pending. The provider's individual `needs-runtime` states distinguish those workflows from the existing Tools. Do not interpret basic Tool availability as complete Skill acceptance. Spreadsheet formula recalculation, final document rendering and platform installation remain separate gates.

The normalized `office_read`/`office_write` contract is not a lossless arbitrary Office editor. Requests that require unsupported preservation must fail closed. Richer workflows follow the selected Skill's actual dependencies and checks; their source presence does not prove installed support. Native file previews remain with `dsh-file-viewer`, and scanned-content tools remain with `dsh-vision-toolkit`.
