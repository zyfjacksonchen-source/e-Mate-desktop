# e-Mate DSH CDP adapter

This ordinary DSH Profile plugin connects only to its fixed loopback Chrome DevTools endpoint (default `http://127.0.0.1:9222`). It registers session-bound browser Tools through the native DSH Tool, approval, settings, subprocess, and system-prompt services.

On the first browser Tool call or explicit **Open Browser** action, e-Mate launches the already-installed Google Chrome with remote debugging bound to loopback and a persistent isolated profile under `$DSH_HOME/runtime/cdp-chrome`. Application startup and capability-status polling never launch Chrome. This satisfies current Chrome's non-default-profile requirement without an extension, developer-mode loading, a downloaded browser, or a manual remote-debugging toggle. The e-Mate Profile enables its independent CDP control grant by default, so the Agent can immediately use `browser_tabs` or `browser_snapshot`; that first call starts Chrome automatically. The user can disable that grant in the capability center. Full Access remains a separate filesystem policy and never bypasses the CDP plugin's own control grant.

For webpage reading and operation, CDP is the only path.

The package contains no extension or browser binary and never downloads one. It only starts the user's installed Google Chrome with the dedicated e-Mate profile.
