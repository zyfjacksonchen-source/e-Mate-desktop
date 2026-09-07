# Source and adaptation

- Repository: https://github.com/NousResearch/hermes-agent
- Fixed commit: `9fc80ac70f6b97e36556c33bc4895b75558d4136`
- Source directory: `skills/productivity/docx`, Skill version 1.1.0.
- License: bundled `LICENSE`, MIT, Copyright (c) 2026 Nous Research.
- Repository popularity was 242902 stars at source inspection on 2026-09-07; this is the whole repository, not an individual Skill rating.
- Provenance: upstream commit `51570f4da746386f23723953f27829f12c1e5334` explicitly replaces earlier proprietary document skills with isolated clean-room MIT implementations. `fad88cf1308e53229b7793d21ce6aad9c1d0134f` extends that rewrite under the same discipline. Only the pinned post-rewrite subtree is included; no predecessor skill is included. These are upstream provenance statements, not an independent legal audit.

## e-Mate changes

Keep the `documents` registration identity; describe the existing Host Python and attachment path, preserve original documents by default, and add Chinese document styling guidance. No Hermes Agent runtime is included.

Text replacement computes original nonoverlapping matches once and edits right-to-left, avoiding replacement-text rescanning and preserving unaffected run formatting. Header/footer and merged-cell paragraph aliases are visited once. Styles can update existing paragraph styles and specify an East Asian font plus paragraph spacing. Relationship validation keys are actual source parts, preventing header/footer relationships from replacing document relationships. Focused regression tests accompany these changes.

Creation/edit/read/package checks are distinct from layout rendering. LibreOffice or a verified equivalent renderer is still required for visual Word/PDF fidelity acceptance; python-docx alone is not a renderer.
