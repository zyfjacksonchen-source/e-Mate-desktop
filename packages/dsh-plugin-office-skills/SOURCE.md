# Source and licensing record

This package is an original e-Mate MIT adapter for the pinned DeepSeek Harness 0.1.0-rc.7 native Skill registry. It contributes only meeting-summary and lieflat-charts; it has no Office executor, Tool/Job registration, client preview, Calc runtime, or bundled Office dependencies. The historical package name is retained for the existing Profile entry.

## Meeting summary preset

- Source: https://github.com/terravic/meeting-transcript-summary-skill
- Fixed commit: `510aab036c6190f3ee547628cb66409def639ac6`
- License: Apache-2.0, preserved in `skills/meeting-summary/LICENSE`.
- Original Skill name: `meeting-transcript-summary`; local provider identifier: `meeting-summary`, Chinese discovery description: “会议总结”. No additional Tool is registered.
- Original `SKILL.md` bytes are unchanged (SHA-256 `852f8724aafd16de632326fb7aa12437bf8129b919f80180de71e216902694ca`); its three references, HTML template and examples are preserved. The source README and explanatory screenshots are not required by the Skill entry and are omitted.
- e-Mate additions: `HOST.md` is prepended by the existing provider with the actual absolute resource directory. It retains the original transcript as authority, makes cleaning optional, uses only existing native Python if available, and does not claim audio transcription or require a connection.
- e-Mate script change (2026-09-07): `clean_transcript.py` now drops an all-digit line only when immediately followed by a subtitle timestamp. Standalone numeric meeting facts survive. All other upstream cleanup behavior remains; timestamps are still removed from the optional derivative, so citations and facts must be checked against the untouched original.
- The helper requires only Python standard-library modules; no Python dependency or runtime is bundled by this addition. The Agent performs synthesis through its existing model channel.

## Lieflat Charts preset

- Fixed source: `larashero3-dotcom/lieflat-charts@eace082a317b696c5570c25826a53a7fa113e984`; all 125 upstream resource identities and the existing documented SKILL.md adaptation are retained under `skills/lieflat-charts`.
- Distribution basis: user-confirmed enterprise authorization on 2026-09-08 for e-Mate bundling. Original PolyForm Noncommercial license and upstream third-party notices are preserved; this is not an MIT relicensing or a fabricated contract. See the preset SOURCE.md and UPSTREAM.json.
- Existing provider and Host guidance only; no new Tool or runtime. Browser-dependent templates retain their network requirements.

Office data and output requests load the Univer Skill and the relevant Unit Skill, then use the existing univer_* tools. This host guidance does not modify the preserved meeting or Lieflat resources or establish installed Univer acceptance.
