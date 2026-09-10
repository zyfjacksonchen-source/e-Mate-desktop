# Source notice

The behavioral source reviewed for this adapter is [`csyangwen/dsh-memory-evolve`](https://github.com/csyangwen/dsh-memory-evolve) at commit `ce7f0faa0e0240f117c29795e9224c0d9ed18183`, licensed MIT with copyright `2026 dsh-external`.

The adapter retains only bounded memory records and copy-on-write import semantics. Its storage and execution are normalized onto DeepSeek Harness `0.1.5-rc.1` public `WorkspaceRegistry`, `storageDomain`, `tools`, and `systemPrompt` services. No upstream UI, HTTP/WebSocket transport, updater, model configuration, COI, session orchestration, global/user memory, sync, dream distillation, or autonomous-learning code is included.
