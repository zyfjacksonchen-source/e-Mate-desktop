# @e-mate/dsh-plugin-memory-evolve

This e-Mate 2.0.18 bundle keeps only the project-memory part of `dsh-memory-evolve` on Harness 0.1.5-rc.1. It resolves every operation from the current Harness Agent and authoritative `WorkspaceRegistry`: sessions attached to the same canonical project share one key, different projects never do, and an ungrouped conversation receives a session-only key. The product-owned `$DSH_HOME/e-mate/general` workspace is explicitly configured as session-only, so separate “通用会话” never share memory despite being attached to that navigation workspace. A missing directory, unknown workspace, or membership mismatch fails closed.

The plugin registers two normal Harness Tools and static prompt guidance. `MemoryStore.copyIn()` is the copy-on-write migration seam: a separate read-only migration reader supplies validated snapshots and SHA-256 source digests; this package never opens or mutates legacy sources.

Not included: global/user memory, Git-branch or cross-device sync, model settings, COI, external CLI dispatch, session orchestration, online update, background self-review, dream/learning automation, HTTP/WebSocket APIs, or a private UI store.
