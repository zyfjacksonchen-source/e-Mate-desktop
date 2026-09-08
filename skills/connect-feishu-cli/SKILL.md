---
name: connect-feishu-cli
description: Connect e-Mate to Feishu through the official Lark/Feishu CLI, its Agent Skills, and browser authorization. Use when the user asks to connect 飞书, Feishu CLI, Lark documents, messages, drive, calendar, tasks, mail, or other Feishu OpenAPI capabilities while letting the Agent install and configure everything except the user's browser approval.
---

# Connect Feishu CLI

In e-Mate Desktop, resolve `<LARK_CLI>` from the existing `EMATE_DESKTOP_PNPM_ENTRY` runtime environment: take three parent directories of that file (the packaged `node_modules` directory), then append `@larksuite/cli/bin/lark-cli` on macOS or `@larksuite/cli/bin/lark-cli.exe` on Windows. Quote the resulting absolute path when executing it. This is the official pinned 1.0.88 executable shared with the connection status owner. Verify `--version` first. Do not use `dlx`, `npx`, `scripts/run.js`, or an online installer as a fallback. If the packaged executable is missing, report an incomplete e-Mate installation; never reset the existing Feishu authorization to work around it. Outside Desktop, use the user's existing official CLI installation and verify its version before proceeding.


Use the installed `skill_find` and `skill_install` tools. Connector Skills are device-global; changing sessions must reuse the same CLI profile and keychain authorization. Do not use an e-Mate built-in Feishu connector, ask for an App ID or App Secret, or put a token in chat.

## Workflow

1. Call `skill_install` with source `https://github.com/larksuite/cli/tree/v1.0.88/skills`, skill `lark-shared`, and scope `global`. The adapter accepts only this version-pinned, SHA-256-verified connector candidate and enforces the global scope, so do not use web search, a second Skill Hub search, or a webhook substitute. Load `lark-shared` after installation.
2. Invoke the official CLI through e-Mate's packaged runtime as `<LARK_CLI> <arguments>`. Do not require `node`, `npm`, `npx`, or `lark-cli` on the public PATH, and do not use `sudo`, Go, a source checkout, or a downloader. Verify it once with `<LARK_CLI> --version`.
3. Before any authorization command, run `<LARK_CLI> auth status --json --verify`. Reuse the existing device-global profile whenever the required identity reports `available: true` and `verified: true`, including user status `needs_refresh`: execute the requested user API operation normally and let the official CLI refresh its keychain token. In this reusable state, do not run `config init`, `auth login`, or another authorization scan.
4. Only when the structured status reports `not_configured`, run `<LARK_CLI> config init --new` once and present its authorization URL. Never replace a valid profile or print/request the saved App Secret.
5. Only when the status or requested operation reports a missing, expired, revoked, or insufficient user authorization, or reports `verified: false`, run `<LARK_CLI> auth login` for the minimum missing domains/scopes. Use `--recommend` only when the user explicitly asks for broad access. A new e-Mate session or app version is never by itself a reason to authorize again.
6. For the requested business domain, call `skill_install` with source `https://github.com/larksuite/cli/tree/v1.0.88/skills`, the exact official `lark-*` Skill, and scope `global`; load it and complete one real requested operation. Use `lark-doc`, `lark-im`, `lark-drive`, `lark-sheets`, `lark-base`, `lark-calendar`, `lark-task`, or `lark-mail`. Use `skill_find` only when the current domain Skill name is unknown.

Keep the CLI's single profile in its native `~/.lark-cli` store and refresh tokens in the OS keychain. Never redirect HOME/config to a session directory. On cancellation or denied scopes, report the exact provider state and do not claim the connection works.
