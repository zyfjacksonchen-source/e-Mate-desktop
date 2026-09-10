# Plugin contracts

## Harness-native composition

Every e-Mate capability is a Cordis/Harness plugin. Host behavior is a Loader entry; browser behavior is the package's `dsh.client` export built by the pinned Harness client preset. Plugins collaborate through Cordis services, Harness registries, Jobs, Session events, Connection, and UI slots.

The following are prohibited:

- opening a second WebSocket, SSE, RPC, or Session transport;
- duplicating Session, Conversation, Tool, approval, Job, Skill, settings, or persistence owners;
- manufacturing activity, Tool, approval, retry, completion, or failure events;
- dispatching central UI behavior by hard-coded Tool or capability IDs;
- bundling another Harness runtime, plugin loader, package manager, or Desktop shell.

## Native-first changes

Before changing a plugin, compare the complete owner path with pinned DSH `0.1.5-rc.1`. Reuse the native service, Tool, event, slot, and lifecycle. An e-Mate adapter may narrow or present native behavior, but cannot replace it.

`packages/dsh/profile/component-inventory.json` is the one first-party Profile roster. Every active entry is built into the Desktop Profile; the inventory is not an independent updater or publication channel. Platform components declare their exact target and native closure, while portable components remain target-neutral.

## Browser and Tool boundaries

Browser modules use Harness Connection and client projections. They never receive raw credentials, execute host paths, or infer durable success from local UI state.

Agent-facing actions use the existing DSH Tool registry. Natural language is an intent surface, not a second implementation. Mutating Tools use the native approval or UserQuestions boundary and preserve the owning service's transaction and receipt semantics.

## Permissions

DSH sandbox policy, DSH approval policy, operating-system privacy grants, credentials, and plugin-owned authorization are independent authorities. `danger-full-access` does not grant Computer Use, CDP, TCC, credentials, Skill installation, or remote-service access. `approval/policy: never` rejects approval-required effects.

Computer Use accepts only its native all-apps setting, an exact application grant, or an allowed interactive lease. Browser control accepts only an explicit loopback CDP endpoint and target binding. Neither capability silently falls back to broader access.

## Skill Hub

Skill Hub reuses the pinned DSH Skill provider and Tool. Catalog, install, update, enable, disable, uninstall, publish, and owned-publication deletion all pass through the existing Host service and owner-scoped Job. Skill ZIPs cannot contain Cordis JavaScript or native executables, and installing a Skill does not expand runtime permissions.

## Enterprise boundary

Enterprise services may authenticate users, enforce model/search policy, lease bounded credentials, and append redacted audit. They never execute local Tools, mutate Sessions, install Skills, control plugins, or drive Desktop update. Browser state receives only redacted status and metadata.

## Desktop update

Natural-language update intent invokes only `e_mate_desktop_update`, which delegates to `desktopUpdates.runInteractiveUpdate()`. Tray, Settings, background, and Agent requests converge on the same `desktop/e-mate-desktop` lifecycle.

No plugin owns an update URL, downloader, verifier, installer, application replacement, relaunch, rollback, or Profile hot-update path. A strictly newer release uses the native Desktop lifecycle; same-version replacement uses the official manual download page.

## Verification

Plugin tests prove their native service/Tool/event boundary and failure behavior. Desktop packaging and installation are verified separately. A fixture, local component build, or browser assertion cannot claim installed or public release success.
