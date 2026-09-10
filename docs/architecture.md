# e-Mate architecture

## Runtime ownership

DeepSeek Harness `0.1.5-rc.1` is the only runtime core. It owns Agent execution, Sessions, durable events, model calls, Tools, approvals, attachments, Jobs, Skills, schedules, workspaces, plugin loading, and persistence.

e-Mate adds product behavior through ordinary Cordis/Profile plugins and native client slots. Browser code consumes Harness Connection and projections; it does not create another transport, event model, or state owner.

## Desktop ownership

`desktop/e-mate-desktop` follows the pinned `deepseek-harness-desktop` Electron/Cordis lifecycle and is the only Desktop shell. The packaged process prepares the fixed Profile, boots the in-process Cordis Host, serves the loopback Web client, creates the native window, and owns orderly shutdown.

The same Desktop package owns macOS and Windows packaging, in-place installation, relaunch, and update. Agent natural language, Settings, tray, and background checks only trigger that one lifecycle.

## Product boundary

e-Mate-specific code is limited to branding, the product Profile, enterprise identity/model policy, redacted audit, and narrow platform adapters. Shared behavior is fixed at the DSH owner before an e-Mate adapter is considered.

The complete active contract and exact source pins live in [target-contract.md](target-contract.md).
