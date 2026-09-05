# Image workflow improvements from the Codex imagegen skill

User requested this comparison during 2.0.18 implementation. The reference is the installed Codex imagegen SKILL.md and its prompting guide; the product uses its own native imagegen/image_batch, enterprise route and Attachment/Job owners.

| Principle | e-Mate implementation |
| --- | --- |
| Intent and execution strategy are separate | Distinguish new images guided by references from edits. Each source has an explicit role; independent outputs use the existing batch, dependent edits are serial. |
| Preserve specific requests | Short purpose/subject/style/constraints guidance; no invented objects, slogans or arbitrary layout. Exact text remains verbatim. |
| Edit invariants survive iterations | Repeat the requested changes and protected identity, marks, framing and regions on each follow-up. |
| Ground references before using them | Use selected native attachments and inspect unseen inputs through available vision; no redundant inspection round for already visible references. |
| Validate actual results | File/CAS completion does not prove semantic success. Use available image checks and report limitations; no hidden replay or automatic failed-batch replacements. |
| Deliver real files | Preview uses the actual attachment. A requested project destination must be exported by existing owners and read back; edits preserve originals unless replacement was requested. |

Detailed guidance lives in the image Tool description, exposed by native Tool Search when relevant, rather than adding a prompt-planning service or another model call. It does not rewrite the admitted prompt, source IDs, canonical provider body or request digest. Batch children retain their exact admitted arguments.

The obsolete statement that batch source/edit tasks are unavailable is removed. The current normalizer and runner already support explicit edit/fusion references. Runtime guidance no longer chooses a parallel legacy subagent fallback based on a one-time startup registry snapshot.

Not copied: Codex's built-in/CLI switching, local API-key setup, or unsupported size/quality/mask/output-path parameters. Draft-quality controls and transparency guarantees require actual upstream capability and output-byte verification. The existing e-Mate model, zero-confirmation behavior, native lifecycle and safe-retry boundaries remain authoritative.
