# PDF Skill source and adaptation record

- Source: installed OpenAI Codex primary runtime `pdf` plugin, version `26.905.11957`.
- Original Skill location: `skills/pdf/` within that plugin. Original author metadata: OpenAI.
- License evidence: the unmodified original `.codex-plugin/plugin.json` is preserved as `UPSTREAM_PLUGIN_MANIFEST.json`, declaring `license: MIT`. The inspected plugin/Skill subtree contains no separate LICENSE or more-specific redistribution restriction; no license/notice/terms file was found in its cache ancestors through the Codex root. This records the available source declaration without inventing a missing copyright notice or license file.
- The four upstream files (`SKILL.md`, the marker script, agents metadata and icon) are byte-for-byte unchanged. `UPSTREAM.json` records each file's SHA-256 and size, plus the original plugin manifest's digest.
- e-Mate adds only this record, `UPSTREAM.json`, the retained manifest and separate `HOST.md`. The host note adapts absolute resource paths, the real `DSH_EMATE_PYTHON` entry and native attachment delivery; it does not modify the upstream workflow or pretend to provide a renderer.
- The original marker performs argument validation only. No runtime execution, dependency installation, PDF generation, rendered-page inspection or packaged-client acceptance was performed as part of this material replacement. Root integration must connect the host note and verify actual supported Python/rendering dependencies.
