# @e-mate/dsh-plugin-turn-fold

e-Mate's owner package for [`dsh-turn-fold`](https://github.com/CH4ACKO3/dsh-turn-fold):
Codex-style turn folding for the DSH WebUI conversation, implemented as a
Harmony Source Patch provider.

```
upstream/plugins/dsh-turn-fold → (build.mjs copy) → lib/
```

The vendored upstream tree is copied verbatim into `lib/`; this package owns the
e-Mate manifest, the Cordis mount row, the build step and the seam assertions.
Provenance and the upstream file hashes live in
[`../../upstream/plugins/dsh-turn-fold/SOURCE.md`](../../upstream/plugins/dsh-turn-fold/SOURCE.md).

## Status — Path C slice 1 (skeleton only)

This package **exists and builds but is not mounted**. It is deliberately absent
from `packages/dsh/profile/component-inventory.json` and from the Desktop profile
inventory list, and `dsh-tidychat` is still the product's folding/navigation
owner. Later slices own the mount, the runtime word migration (facts §76), the
native-owner stand-down and the tidychat retirement.

```sh
pnpm --dir packages/dsh-plugin-turn-fold run build          # copy + assert seams
pnpm --dir packages/dsh-plugin-turn-fold run verify:seams   # assert only
pnpm --dir packages/dsh-plugin-turn-fold run test
```

## How it works (upstream, unchanged)

Three shape-guarded Source Patches run in memory against the compiled browser
bundle; installed DSH files are never modified. Each `select` must match exactly
once (`expect: 1`), so an incompatible compiled shape fails closed.

| Patch | Selector (expect 1) | Effect |
|---|---|---|
| `inject-turn-fold-runtime` | `FunctionDeclaration[name.name="ChatView"], VariableStatement:has(VariableDeclaration[name.name="ChatView"])` | injects the fold renderer, disclosure UI, metrics, settings and locale runtime |
| `rewrite-node-render-loop` | `CallExpression[arguments.0.name="ChatNodeList"]` | routes node rendering through the per-turn renderer, keeping the native node renderer |
| `install-turn-fold-services` | `VariableStatement:has(VariableDeclaration[name.name="t"][initializer.expression.name.name="bind"])` | registers the bundled en/zh dictionaries and binds the native settings scope |

The consumer of `dsh.harmony.patches` is the vendored
[`@e-mate/dsh-plugin-harmony`](../dsh-plugin-harmony) runtime — DSH 0.1.5 itself has
no Harmony layer. The injected runtime executes **inside the target module
factory**, so it also depends on host-scope symbols (below).

## Seam assertions (fail closed)

`scripts/build.mjs` copies the vendored files and then runs
`scripts/seams.mjs` against the **pinned build**
(`upstream/deepseek-harness/packages/client/ui-chat/lib/client.js`,
sha256 `cf53ae8f5978901504286189a64506febf09cd237d097db3abf3f39b3953ba97`, commit
`d1d095bee770c3e9d302f844083e02f0b74576ee`). It asserts:

1. each of the three selectors still matches **exactly one** node, and the
   `ChatNodeList` call still carries the props argument the rewrite reads;
2. the injected runtime's host-scope symbols are bound in the `ChatView` scope
   chain. The list is derived from a full free-identifier analysis of the vendored
   `inline-source.cjs` (277 declarations vs 300 referenced identifiers) and has
   **six** entries: `react`, `react_jsx_runtime`, `formatRunDuration`,
   `formatTokens`, `_deepseek_ai_dsh_client_ui_primitives` (the compiled alias the
   injected `DisclosureRow` call uses) and `ReasoningRow` (the ui-chat factory's own
   reasoning row). The upstream header comment names only the first four.

Current result (2026-09-11, this worktree):

```
turn-fold seams vs @deepseek-ai/dsh-client-ui-chat@0.1.5-rc.1
  OK   inject-turn-fold-runtime       1/1  line 2072
  OK   rewrite-node-render-loop       1/1  line 2535
  OK   install-turn-fold-services     1/1  line 8272
  OK   host symbols in ChatView scope: react, react_jsx_runtime, formatRunDuration, formatTokens, _deepseek_ai_dsh_client_ui_primitives, ReasoningRow
```

The checker needs the pinned Harness checkout **built** (`lib/` is build output)
and its `node_modules/typescript`; when either is missing it fails closed with
that instruction instead of skipping. `@phenomnomnominal/tsquery` is not a
dependency of this repository, so `scripts/tsquery-subset.mjs` re-implements the
exact tsquery semantics these selectors use and throws on anything outside that
subset.

## Runtime gaps for later slices (0.1.2-alpha-era symbols that 0.1.5 no longer has)

These are inside the vendored `inline-source.cjs` and are **not** seam failures —
they are the port work the next slices own:

| Vendored code | 0.1.5 replacement |
|---|---|
| `timeline.playbackClock` (`inline-source.cjs:1048`) | deleted; use `TurnLocation.start?.time` or `turn-tail.data.time` + `ttftMs` |
| `assistant-step.data.usage.{inputTokens,outputTokens,cache*}` (`:166-176, :1094`) | `turn-tail.data.tokenUsage.{uncachedInputTokens,outputTokens,totalTokens,cacheReadTokens?,cacheWriteTokens?,reasoningTokens?}`; `AssistantChatData.usage` is `unknown` in 0.1.5 |
| `TurnLocation.status` compared against 0.1.1 values | `open \| closed \| unknown` needs label remapping |

`settingsNamespace()` was deleted in 0.1.5 but this provider never used it: it
registers through `ctx.settings.register('dsh-turn-fold', schema, { base })`,
which survives.

## Dependencies

The vendored `settings.cjs` lazily requires `@deepseek-ai/schemastery` when it
builds its settings schema. This package adds **no** registry dependency: the
pinned Harness vendors `@deepseek-ai/schemastery@3.18.2` and declares it in
`base-contract.json#runtime_imports`, so it is linked through
`eMate.baseImports`. Whether that lazy `require` resolves from the shipped
Desktop profile bundle directory is a boot-time check the mount slice owns.
