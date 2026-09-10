# @e-mate/dsh-plugin-office-skills

A native Skill provider for `meeting-summary` and `lieflat-charts` on the pinned Harness rc.7 Profile. The historical package path remains stable; document, PDF, spreadsheet and presentation work belongs to the separate dsh-univer-office integration.

The provider injects only `skills` and uses the native Skill registry and bundled rank. It retains both presets' instructions, resources, source records and licenses. Each `HOST.md` resolves the actual resource directory. Meeting summaries preserve original transcript facts; Lieflat primarily creates HTML visualizations and loads `univer` plus the corresponding Unit Skill when Office data or outputs are required.

This package registers no Tools or Jobs and includes no client preview, Calc executor, Office library, font runtime or Python dependency. The optional meeting transcript cleaner uses Python's standard library when the existing host provides it; text summarization does not require the cleaner.

Run `pnpm build`, `pnpm test:types` and `pnpm test` with the repository's Node toolchain. Tests use the real pinned SkillRegistry, verify that no Tools appear and disposal removes both Skills, check the preserved original content and Lieflat's 125-file hashes/templates, and execute the transcript helper against numeric facts. These are source/native checks, not installed or provider acceptance.
