# PPT Master source provenance

- Repository: <https://github.com/hugohe3/ppt-master>
- Fixed commit: `c45b7427e707d8695f1bf7df4d20360d05f82e7c`
- Original entry/version: `skills/ppt-master/SKILL.md`, `ppt-master` / `6.3.0`.
- Acquisition: official fixed-commit codeload tarball. The complete `skills/ppt-master/` subtree is distributed together with its nine actually referenced outer documentation files under `upstream-reference/`. Every source file is checked against the untruncated GitHub recursive tree's Git blob identity and size; `UPSTREAM.json` also records SHA256, original Git mode, source tree and archive digest.
- Original Skill source baseline: **12,953 files / 79,902,360 bytes**, all verified before adaptation. Of these, 12,949 files remain byte-for-byte unchanged; four Markdown files change only relative reference URLs. Nine supplementary upstream reference documents (158,714 original bytes) retain their prose with local URL adaptation. e-Mate-authored additions are only `HOST.md`, `SOURCE.md` and `UPSTREAM.json`. No upstream script was executed to obtain or vendor the sources.

## Distribution and attribution

PPT Master itself is MIT, Copyright (c) 2025–2026 Hugo He. Keep the original `LICENSE`, `SPONSORS.md`, `SPONSORS_CN.md`, identity metadata and attribution guards intact. The original Skill already limits sponsor recommendations to an explicit user request. No sponsor service was used during vendoring.

Third-party resources retain their original notices and conditions:

- `templates/icons/THIRD_PARTY_NOTICES.md`: CHUNK / Noah Jacobus under CC BY 4.0 with upstream modifications recorded; Tabler and Phosphor MIT attribution; Simple Icons CC0 project notice with per-brand license/trademark qualifications. Inclusion is not permission to imply a brand endorsement or ignore brand-specific rules.
- `scripts/pptx_shapes/data/NOTICE.md`, `LICENSE-APACHE-2.0.txt` and `LICENSE-OPEN-XML-SDK-MIT.txt`: Apache POI and Open XML SDK geometry-data provenance.
- `templates/sounds/THIRD_PARTY_NOTICES.md` and `CC0-1.0.txt`: original sound-source notices and license text.

The source subtree is intentionally complete. Its main byte contributors are the AI image comparison references (45,281,127 bytes), sound assets (12,543,374 bytes) and icon library (10,181,519 bytes / 12,029 files). These are workflow resources, not copied Python environments. No runtime wheels, site-packages, PyMuPDF library or proprietary artifact-tool runtime are added. Upstream `requirements.txt` retains its exact original bytes, including optional dependency declarations; it is not an e-Mate install lock or authorization to distribute those libraries.

## Minimal reference adaptation

The standalone Skill has four links that originally leave its directory: `references/plan-core.md` points to upstream ownership rules; `scripts/docs/narration.md` points to audio documentation; `scripts/docs/advanced-image-motion-smoke.md` and `scripts/docs/svg-pipeline.md` point to code-style rules. Their reachable functional documentation requires five rule files and bilingual audio/animation references (nine files total). These are preserved under `upstream-reference/docs/`; references back into the Skill use its actual local paths. The nonfunctional repository-contribution navigation points to its fixed-commit GitHub page, avoiding vendoring the repository homepage, developer instructions or unrelated files.

`UPSTREAM.json` distinguishes the original blob/hash/size list from each modified and supplementary file’s distributed hash and exact URL replacements. No runnable Python, mandatory guard, Skill entry text or template content is modified. Literal example paths inside upstream code samples are retained as examples, not asserted to be installed resources.

## State and integration boundary

This commit supplies source materials and a Host guide only. The existing office Skill provider, managed Profile packaging, dependency locks and platform installation are owned by the integration task. The provider must expose `HOST.md` with its actual `{{SKILL_DIR}}` substituted before the original Skill content; it must not invent a separate Tool or copy this Skill into the user's own Skill directory.

Original Python syntax parsing, source hashes and local resource closure checks establish source integrity only. They do not establish native dependency availability, a working browser/PPTX renderer, offline support for optional services, installed Skill discovery, successful deck generation or macOS/Windows acceptance. Native PPTX generation/editing, all selected dependencies and final visual verification remain pending the integration task.
