# turn-fold 与固定版 0.1.5-rc.1：逐条用户可见行为的 feature-parity 对照

> **English abstract.** Per-behaviour parity between what the pinned Harness `0.1.5-rc.1` (fork `ff9a977890`) natively
> renders in the conversation UI and what the third-party plugin `dsh-turn-fold` documents it provides. Grading is
> **(a)** already native and shipped, **(b)** native but gated/bypassed in this profile, or **(c)** genuinely absent —
> and for every (c) the supported slot or service that could carry it, with its declaration site. The plugin's three
> in-memory tsquery selectors still resolve exactly once against today's pinned compiled bundle, so the injection is
> mechanically possible; what blocks a port is the deleted delivery mechanism (`dsh.harmony.patches`) and the
> 0.1.2-era runtime data shapes, not the selectors. No code was changed; this document is uncommitted.

- 基线：`desktop/e-mate-desktop/base-contract.json` → `harness_version: 0.1.5-rc.1`、`harness_commit: ff9a977890dafc4fe9b05634470db9a33bc9a3ef`（第 11-12 行）。
- 原生源码根：`upstream/deepseek-harness/`（子模块 **未改动**，`git rev-parse HEAD` = `ff9a977890dafc4fe9b05634470db9a33bc9a3ef`）。
- 本文件只读；写集仅 `docs/2.0.18/**`；**未提交**。

---

## 1. 两条证据来源

**(2) 插件规范 = 其 README 原文（本机实取，非二手转述）**

| 项 | 值 |
|---|---|
| URL | `https://github.com/CH4ACKO3/dsh-turn-fold/blob/main/README.md`（实取原文件：`https://raw.githubusercontent.com/CH4ACKO3/dsh-turn-fold/main/README.md`，`curl -sSL` → HTTP 200，4259 字节） |
| sha256 | `924d083633ee51c2eb62f872adea5de0d0565ef153b3bc4cb25c1dc53028cfed` |
| 与仓库历史的关系 | 与 `3c8042caee` vendored 的 `upstream/plugins/dsh-turn-fold/README.md` **逐字节相同**（`diff` 为空，sha256 相同） |
| 上游 pin | `@ch4acko3/dsh-turn-fold@0.6.0`，commit `69867494627d58da4d17f5842bda7d1c36fa34d2`（`upstream/plugins/dsh-turn-fold/SOURCE.md` 的 provenance 表） |

**(1) 原生渲染 = 固定版 checkout 的源码与已编译产物**：`upstream/deepseek-harness/packages/client/ui-chat/src/**`、
`.../ui-conversation/src/**`，以及被三个选择器当作目标的 `packages/client/ui-chat/lib/client.js`
（sha256 `cf53ae8f5978901504286189a64506febf09cd237d097db3abf3f39b3953ba97`）。

本文件引用的每个 `file:line` 都是本次会话**实际读过**的行，不是从记忆或别的文档转抄。

---

## 2. 逐条用户可见行为对照

判定列：(a) 已原生且已出货 / (b) 原生有但本 Profile 未启用或语义不同 / (c) 原生确实没有。

| # | 插件 README 声明的行为（规范 (2)） | 固定版 0.1.5-rc.1 的事实（(1)，file:line） | 判定 |
|---|---|---|---|
| B1 | 轮次进行中**摘要条常驻**，原生 thinking / notes / commands / tool calls 继续流式 | 摘要条在 `!foldable` 时直接 `return null`（`ui-chat/src/client/chat/TurnProcessNodeView.tsx:11`），而 `foldable` 以 `turnClosed` 为前提（`chat/ChatNodeSeat.tsx:62-68`）⇒ **轮次进行中没有摘要条**。原生只有轮次级运行指示：`ChatView.tsx:807` `{running && <TurnStatus .../>}`，`TurnStatus`（`:168-201`）= `chat.deepDiving` 文案 + 仅当运行 ≥15s 才出现的秒表（`:190`），**不含任何计数**。e-Mate 已有的 `e-mate-thinking-status` 只是这一行的品牌投影（`packages/dsh/profile/plugins/emate-shell/src/client/index.ts:473-477` → `thinking-status.tsx:32`，选择器 `[role="status"][aria-live="polite"]`） | **(c)** |
| B2 | 连续 reasoning / context injection / 工具活动**从第二项起合成一个紧凑组** | 每条 reasoning block 各自一个 disclosure（`chat/AssistantMarkdown.tsx:85-95` → `chat/ReasoningRow.tsx:28`）；每个工具调用树各自一个 Chat 节点（`conversation-nodes/tool.ts:256-263`）。**跨节点的"从第二项起成组"不存在** | **(c)** |
| B3 | 轮次落定后，已知 agent 活动（含 context injection）移入**紧邻最终答复之前**的一个 disclosure | 原生 `turn-process` 节点即 "projected before the finalized answer"（`contract/chat-nodes.ts:101` 注释）；控制节点锚在 `controlAnchorSeq + processControl(-0.1)`（`conversation-nodes/turn-process.ts:294-299` + `conversation-nodes/common.ts:17`），`controlAnchorSeq` 取最早的过程证据（`turn-process.ts:189-205`）；可折叠时 `processStartSeq..answerAnchorSeq` 的成员全部 `processHidden`（`ChatNodeSeat.tsx:69-73, 98`）⇒ 折叠态可见序列 = 用户消息 → 摘要条 → 最终答复 | **(a)** |
| B4a | 指标含**墙钟时长** | turn tail 的时钟 pill 即 `message.ranFor` 时长，`runMs = turn.end.time - turn.start.time`（`chat/TurnTailNodeView.tsx:28-30, 52-64`；`chat/TurnUsagePanel.tsx:132, 144`） | **(a)** 但在**轮次页脚**，不在摘要条里 |
| B4b | 指标含**工具调用计数** | 摘要条标签显示 `toolCallCount` / `messageCount` / `subagentCount`（`TurnProcessNodeView.tsx:14-37`；locale `ui-chat/src/client/locale.ts:172-179`） | **(a)** |
| B4c | 指标含 **input/output tokens** | 每轮精确 token 面板 `TurnUsagePanel`（`TurnTailNodeView.tsx:52-64`、`TurnUsagePanel.tsx:46, 96-118`；数据 `conversation-nodes/turn-tail.ts:150-152` 的 `deriveTurnTokenUsage`）；会话级 `StatsPills`（`chat/StatsPills.tsx:317-359`） | **(a)** 但同样在页脚 / 会话栏，不在摘要条里 |
| B4d | 指标**可配置**（默认 4 项、共 10 个可选字段、可排序） | 原生 chat 设置**只有** `transcriptView`（`ui-chat/src/chat-settings.ts:9, 12, 18, 27-29`），注册为 `settings.general.item` 的 `id: 'transcript-view'` 行（`client/apply.ts:85-94`）。**没有指标字段配置** | **(c)** |
| B5 | 最终答复用 `turn-tail.closing.finalNode` 定位，不靠 finish_reason / DOM | 原生是**同一个接缝**：`TurnTailChatData.closing`（`contract/chat-nodes.ts:86-99`）由 `finalized.findLast(hasText) ?? null` 解析（`conversation-nodes/turn-tail.ts:117-135`），消费于 `TurnTailNodeView.tsx:24-27` 与 `chat/AssistantNodeView.tsx:13-18` | **(a)** 机制相同 |
| B6 | completed / stopped / interrupted 三类轮次都折叠 | 折叠前提是 `TurnLocation.status === 'closed'`（`ChatNodeSeat.tsx:67` ← `conversation-nodes/turn-process-presentation.ts:67`），status 只由 `turn/end` 是否存在决定（`ui-conversation/src/client/conversation/location-index.ts:364-368`）；被中断的 assistant 会定稿为 `status: 'interrupted'`（`conversation-nodes/assistant.ts:212-227, 264-265`）⇒ 只要有**含文本的已定稿答复**就折 | **(a)** 完成态；stopped/interrupted 取决于该轮是否有含文本的已定稿答复 |
| B7 | stopped 与 interrupted 有**不同**的状态标签 | 原生**没有轮次级状态标签**：`TurnLocation.status` 只有 `open|closed|unknown`（`ui-conversation/.../contract/conversation.ts:96`）。原生标签是**节点级**的：停止 = `message.stopped`（`locale.ts:180`，渲染 `AssistantMarkdown.tsx:138`）、失败 = `message.turnError`（`locale.ts:191`）、截断 = `message.maxTokens`（`locale.ts:192`） | **(c)**（折叠条上的轮次状态） |
| B8 | closing branch 不可用（`branchUnavailable`）时**保持展开** | `branchUnavailable` 只在轮次页脚被消费：算出 `turn-tail.ts:158` → `TurnTailNodeView.tsx:49` → `chat/MessageIconActions.tsx:92-108`（禁用分支按钮）。`ChatNodeSeat` 的折叠判据（`:62-101`）**完全不读它** | **(c)** |
| B9 | closing 答复之后还有节点时**保持展开** | 原生最接近的是 `compactAnswer`（`turn-process-presentation.ts:47-56`），但它只影响**答复行自身**的压缩标记（`ChatNodeSeat.tsx:94-97, 134`），不阻止过程折叠 | **(c)** |
| B10a | 活动内有**键盘焦点**时保持展开 | 原生的等价物：`chat/searchable-hidden.ts:17-20` 在"要隐藏但焦点仍在子树内"时改为 reveal（调用处 `ChatNodeSeat.tsx:99-102`）；并以 `hidden="until-found"` + `beforematch` 让浏览器查找也能揭开（`:21, 27`） | **(a)** |
| B10b | 活动内有**文本选区**时保持展开 | 原生判据只有 `element.contains(activeElement)`（`searchable-hidden.ts:17`），没有任何选区探针；隐藏子树内也无法产生选区 | **(c)** |
| B11a | **open** 轮次保持展开 | `processWindowReady` 要求 `processPresentation.turnClosed`（`ChatNodeSeat.tsx:67`）⇒ 不折叠，成员原样内联 | **(a)** |
| B11b | **closing-less** 轮次保持展开 | 要求 `processSpec.answerAnchorSeq !== null`（`ChatNodeSeat.tsx:65`）；无含内容答复时 `answerAnchorSeq` 为 `null`（`turn-process.ts:117-147`） | **(a)** |
| B11c | **failed** 轮次保持展开 | **不等价**：失败轮次同样有 `turn/end` ⇒ `closed`（`location-index.ts:368`），若该轮有含文本答复则过程**会折**；但 `turn-error` 是独立 kind（`contract/turn-process.ts:20-33`，判定见 `ChatNodeSeat.tsx:71`）⇒ "错误不被藏"成立、"整轮不折叠"不成立 | **(b)** 语义部分不同 |
| B11d | **max-token** 轮次保持展开 | 同上：`turn-max-tokens` 是独立 kind（`contract/turn-process.ts:26`），提示锚在 closing 答复之后（`conversation-nodes/turn-max-tokens.ts:26-42`），过程仍可折 | **(b)** 语义部分不同 |
| B12 | 展开**复用原生 node renderer**（工具详情/复制/文件链接仍可用） | 原生折叠只是给同一个 `ChatNodeSeat` 行加 `hidden`（`ChatNodeSeat.tsx:124-147` + `searchable-hidden.ts:21`），不做任何重渲染；答复行的内联思考另由 `AssistantNodeView.tsx:23-28` 隐藏 | **(a)** |
| B13 | 展开态按 **session × turn** 记忆（WebUI 存活期内） | 原生：每个渲染中的 Session 一份 chat store（`client/stores.ts:31-46`；注册处 `client/apply.ts:79, 96-107`；props `& PropsStore<ChatStore>` `contract/slots.ts:158`）；表项 `{turn, answerStep}`（`stores.ts:41`），`setOpen` 仅在 `answerStep !== null` 时写入（`ChatNodeSeat.tsx:57-61`），关闭即删（`stores.ts:35-40`）；不写 host 设置 ⇒ **仅内存** | **(a)** 语义一致 |
| B14 | 键盘可见焦点、可访问状态与动作标签、响应式换行、reduced-motion | `<button aria-expanded>`（`TurnProcessNodeView.tsx:42-58`）；chevron 100ms 过渡并在 `prefers-reduced-motion` 下关闭（`TurnProcessNodeView.module.css:28, 44-48`）。**换行取向不同**：标签是 `white-space: nowrap` + `text-overflow: ellipsis`（`:35-42`），即截断而非换行 | **(a)** + 换行取向不同 |
| B15 | 开合有短过渡，**关闭后 unmount** 活动 | 原生**刻意不 unmount**：子树保持挂载、用 `hidden="until-found"` 隐藏，以便浏览器查找能揭开（`searchable-hidden.ts:3-8, 21, 24-29`） | **(b)** 取向相反 |
| B16 | （导航）插件 README **没有**把导航写成它的行为：正文只描述折叠，安装/测试段亦无导航 | 原生导航：`ChatView.tsx:763-769` **无条件**渲染 `TurnNavigator`，`chat/TurnNavigator.tsx:129` 仅在 `items.length < 2` 时不渲染；固定 10px 间距（`:19`）、6px 端内边距（`:21`）、点击跳转与未加载轮次翻页（`ChatView.tsx:722-758`） | **(a)** 已原生；**插件载体本身不含导航**（与 §84.1 第 4 行一致） |

### 2.1 关于 B6/B11 的一处精确化（避免把"落定"读成"没失败"）

`TurnLocation.status` 是 `turn/end` 的存在性函数，**不区分结束原因**（`location-index.ts:368` 只看 `draft.end !== undefined`；
`turn/end.data.reason.kind` 的 `'error'` / `'max-tokens'` 只被 `conversation-nodes/turn-error.ts:31-32` 与
`turn-max-tokens.ts:41-42` 读来生成**独立提示节点**）。因此"failed / max-token 保持展开"在原生只对**提示行**成立，
不对**整轮**成立——这是与插件规范唯一的语义级差异，其余 (c) 项都是"原生没有这个行为"。

---

## 3. (b)/(c) 项：受支持的承载面（有没有槽/服务能承载，而不是"能不能加代码"）

前置事实（决定下面每一条的结论）：**折叠判据在槽之上算好后传入**。
`ChatNodeSeat.tsx:62-101` 算出 `processWindowReady` / `processMember` / `processHidden` / `foldable`，
只把 `{ spec, foldable, open, setOpen }` 作为 owner props 交给渲染器（`contract/slots.ts:99-104`）。
插件**拿不到** `turnClosed`、`branchUnavailable`、`hasMore(historyIncomplete)`、`compactTranscript`。

判读方式（按 §5 的豁免契约）：每条都给出**两条可达路径**——(i) 走受支持的槽/服务要付出什么代价，
(ii) 走豁免允许的内存补丁需要动编译产物的哪一段。

### 3.1 B1（轮次进行中的摘要条）— 有承载面

- 槽：`conversation.chat.node`（keyed，session scope）的 `key: 'turn-process'`。声明 `ui-chat/src/client/contract/slots.ts:182-189`；
  **复用 key 即替换该节点渲染器**（`:179-180`）。e-Mate 既有先例：`packages/dsh-plugin-file-import/src/client/index.tsx:632-636`
  以 `priority: -1` 装饰、并从同 key 的 `priority: 0` 行取回 `inject`/`locale`。
- 为什么可行：open 轮次**已经有** `turn-process` 节点——只要该轮出现任何过程证据就产出（`turn-process.ts:240-246` 的
  `publication` + `:278-300` 的 `buildViewNode`），此时 `answerAnchorSeq` 为 `null`；节点数据已带
  `toolCallCount/messageCount/subagentCount`（`contract/chat-nodes.ts:101-110`）。原生渲染器只是 `!foldable` 时返回 null
  （`TurnProcessNodeView.tsx:11`），槽位本身仍然被渲染（`ChatNodeSeat.tsx:136-146`）。
- 限制（决定了它现在**不该**做）：墙钟与 token **不在**该节点数据里（token 只在 `turn-tail` 的 `tokenUsage`，
  `turn-tail.ts:150-152`，而该节点要求 `turn/end`）。要在条上凑出墙钟/ token 就得从 `node.location.turn.start` 与
  assistant 节点重新推导。走**槽**路线时这会与原生页脚形成两套口径（第二套事实源）；豁免允许的**内存补丁**
  路线没有这个问题，因为它可以直接复用原生 `turn-tail` 的数据与渲染器。

### 3.2 B2（跨节点分组）— 槽路线**不可达**

每个 keyed renderer 只收到**一个**节点（`slots.ts:182-189` 的 `keyProps: {[Kind]: {node}}`），
而"哪些相邻节点属于同一组"的判定位于槽之上的 `ChatNodeSeat`/`ChatView`。
走**槽**路线因此不可达（§84.3 表 1b 的 (b) 情形）；这正是 §5 豁免存在的理由——用内存 AST 改写实现跨节点分组，
而不新增第二个 owner。

### 3.3 B4d（摘要条指标可配置）— 有服务承载面，但依赖 B1

- Host：`ctx.settings.register(ns, schema, { base })`（`upstream/deepseek-harness/packages/settings/settings/src/index.ts:419-423`，
  0.1.5 仍在；turn-fold 自己就是这么注册的，见 §77.4 末行）。
- 客户端：`ctx.settingsScope.bind({ namespace })`（`ui-chat/src/client/apply.ts:81-83`）+ 设置行槽
  `settings.general.item`（`:85-94`）。
- 但"可配置的摘要条字段"在原生判据里不存在（摘要条标签是硬编码的三种计数），且条本身在轮次进行中不显示（B1）
  ⇒ 该项与 B1 绑定，不能单独补。

### 3.4 B7（折叠条上的轮次状态标签）— 有承载面

- 槽：同 §3.1（`conversation.chat.node` / `turn-process`）；另外每个 keyed renderer 都能拿到全量选择器
  `useChat`（`SessionStandardProps.useChat`，`slots.ts:166-169`），所以事实来源齐备：
  `TurnLocation.status`（`conversation.ts:96`）、assistant 的 `status: 'running'|'settled'|'interrupted'`（`contract/chat-nodes.ts:31`）、
  `turn/end` 的 reason（`turn-error.ts:31-32`、`turn-max-tokens.ts:41-42`）。
- 槽路线的风险：原生已有节点级标签（`message.stopped` / `message.turnError` / `message.maxTokens`），
  再加一套轮次级说法即两套事实源。豁免路线则在**同一个**原生折叠条上改写标签，不新增 owner。

### 3.5 B8 / B9（因 `branchUnavailable` 或"closing 之后仍有节点"而保持展开）— 有渲染面，**没有判据面**

条的渲染可以被替换（§3.1），但"何时该折"由 `ChatNodeSeat.tsx:62-101` 决定，且 `branchUnavailable`
根本没进那条判据（它只在 `turn-tail.ts:158` 产出、在 `MessageIconActions.tsx:92-108` 消费）。
走**槽**路线要"因 branchUnavailable 而展开"必须改 `ChatView`/`ChatNodeSeat`（§84.3 表 1b 同款判定）；
豁免允许的内存补丁可以不新增 owner 地补上这条判据，但代价是它**必须同时进入接缝清单并 fail closed**，
否则一次 Harness 重建就会让这条判据静默失效。

---

## 4. 可移植性：三个选择器对 0.1.5-rc.1 的**实测**事实

上一轮本仓库确实 vendored 过这个插件，并把它的接缝量到了同一个 bundle 上；本节**复跑**了那次检查器
（取自 `04b43379f4`，不重新推导），以及它的负向控制。

### 4.1 复跑命令与原始输出

```sh
git show 04b43379f4:packages/dsh-plugin-turn-fold/scripts/seams.mjs        > /tmp/tf-seamcheck/scripts/seams.mjs
git show 04b43379f4:packages/dsh-plugin-turn-fold/scripts/tsquery-subset.mjs > /tmp/tf-seamcheck/scripts/tsquery-subset.mjs
EMATE_HARNESS_ROOT=upstream/deepseek-harness node /tmp/tf-seamcheck/scripts/seams.mjs
```

```
turn-fold seams vs @deepseek-ai/dsh-client-ui-chat@0.1.5-rc.1
  build: <worktree>/upstream/deepseek-harness/packages/client/ui-chat/lib/client.js
  sha256: cf53ae8f5978901504286189a64506febf09cd237d097db3abf3f39b3953ba97
  OK   inject-turn-fold-runtime       1/1  line 2072
  OK   rewrite-node-render-loop       1/1  line 2535
  OK   install-turn-fold-services     1/1  line 8272
  OK   host symbols in ChatView scope: react, react_jsx_runtime, formatRunDuration, formatTokens, _deepseek_ai_dsh_client_ui_primitives, ReasoningRow
```

与 facts §77.3（`docs/2.0.18/dsh-0.1.5-upgrade-facts.md:2504-2511`）**逐项相同**：同一 sha256、同一行号
2072 / 2535 / 8272、同一 6 个宿主符号。即 §77 的测量可复现。

补充（本次实测）：该检查器不是只能从历史取回——工作树里已重新出现的 `packages/dsh-plugin-turn-fold/scripts/seams.mjs`
与 `04b43379f4` 的同名文件 `diff` **完全相同**（三个 SELECTORS 与 `HOST_SYMBOLS` 逐字一致），所以上面这段输出
同时也是**当前工作树里那份守卫**对当前 bundle 的测量结果。

### 4.2 负向控制（证明守卫承重，而不是恒真）

`04b43379f4` 新增的 `packages/dsh-plugin-turn-fold/test/seams.test.mjs`（151 行）对**真实 bundle 的改写副本**做两种破坏：

| 破坏 | 断言 | 结果 |
|---|---|---|
| 把 `ChatView` 全量改名为 `ChatViewRenamed`（并断言改名确实落在文本上） | 该接缝 `found 0`、`ok:false`、`detail` 匹配 `/no match/u`；**其余接缝不受影响** | fail closed |
| 追加一次被匹配到的调用锚点（复制 `expect: 1` 的锚） | 该接缝 `found 2`、`ok:false` | fail closed |
| 常量本身 | `HOST_SYMBOLS.length === 6`、每个符号 `resolved === true` | 6/6 |

⇒ **"选择器写死成恒真也照样绿"的概率为零**：接缝缺失或重复都会让检查器失败。

### 4.3 结论（严格限定在"三个选择器"这个事实层面）

**把这三段 tsquery AST 改写打进 0.1.5-rc.1 的已编译 `ui-chat` bundle 在机制上是可行的**：
三个选择器各命中一次，注入体读取的六个宿主作用域符号全部仍绑定。这**不等于**插件能在 0.1.5 上工作，因为：

1. **投递机制在 0.1.5 里不存在**：它靠 `package.json` 的 `dsh.harmony.patches`（`upstream/plugins/dsh-turn-fold/package.json:32-35`），
   而 0.1.5 全仓零处 `harmony` 消费者（§74.1）；0.1.5 的原生挂载方式是 `dsh.bundle.patch` 的 insert 行。
2. **运行时数据面是 0.1.2 世代的**（§77.4 表，逐行 file:line）：`timeline.playbackClock` 在 0.1.5 已删、
   `assistant-step.data.usage.*` 已迁到 `turn-tail.data.tokenUsage.*`、`loc.turn.status` 取值世代不同
   （0.1.1 的 `completed|aborted|interrupted` → 0.1.5 的 `open|closed|unknown`）。
3. **它自己声明的支持区间不覆盖 0.1.5**（`package.json` 的 peerDependencies：
   `ui-chat >=0.1.2-alpha.5 <0.1.3-0`；`ui-conversation`/`dsh-settings` 双区间；hard peer `dsh-harmony ^0.8.10`）。
   注意这是**声明事实**，不是选择器事实——而且 harmony 自己的版本区间门只是告警、不是 gate（§77.5）。

---

## 5. 与仓库当前契约的关系（根 AGENTS.md 新增的 turn-fold 豁免）

- `b1357ced55`（"Revert Path C: retire turn-fold and harmony, keep tidychat as the single owner"）已整体撤回；
  当前 HEAD `bbdd51ea65` 内 `dsh-plugin-turn-fold`/`dsh-plugin-harmony`/`upstream/plugins/dsh-turn-fold` **命中数 = 0**
  （`git ls-tree -r --name-only HEAD | grep -c ...` 实测）。
- **当前契约（根 `AGENTS.md`，本会话期间刚更新，优先于 facts §82/§84 的历史结论）**逐字写道：
  「One capability is exempt by explicit user ruling: Codex-style turn folding is delivered by the dsh-turn-fold
  provider, whose three shape-guarded patches apply in memory to the compiled ui-chat bundle at load time.
  That exemption is narrow and evidenced: the patches must stay in memory (never written to disk), each selector
  must still match exactly once or the patch is refused, the bundle hash must be verified, and no other plugin
  may parse sources or rewrite a Harness artifact.」
  ⇒ 本文件因此**不是**"不该做"的依据，而是这项豁免工作**需要的对照与证据**：§2 说明原生已有什么（避免把
  已原生的行为重复实现成第二套事实源），§3 给出每个缺口**受支持的入口**，§4 给出"选择器仍各命中一次 +
  宿主符号仍绑定"的实测证据。facts §84.4 的"不存在能力缺口"是当时（无豁免时）的结论，已被逐字豁免覆盖。

  **四项豁免条件 ↔ 本次实测的对应关系**：

  | 豁免条件 | 现状 | 证据 |
  |---|---|---|
  | 补丁只在内存中施加、绝不落盘 | 载体本身就是内存改写（`dsh.harmony.patches`），上游从不在磁盘上改写已安装文件 | §4.3 第 1 条；上游 README「Installed DSH files are never modified」 |
  | 每个选择器仍须恰好命中一次，否则拒绝 | **已满足**（今天实测 1/1、1/1、1/1，且有负向控制证明缺失/重复都会 fail closed） | §4.1、§4.2 |
  | **bundle hash 必须被校验** | **未满足**：现有守卫只把 sha256 **打印/放进报告**（`packages/dsh-plugin-turn-fold/scripts/seams.mjs:207-208, 301, 318`），
**没有**任何断言把它与钉住值比较（全包 grep `cf53ae8f`/`expectedHash`/`BUNDLE_HASH` 均零命中） | §4.1 的 sha256 = `cf53ae8f…3ba97`，可直接作为钉住值 |
  | 其他插件不得解析源码或改写 Harness 产物 | 现状符合：仓库另有 `scripts/no-core-rewrite-guard.mjs` 一类守卫约束插件面（facts §84.6；该守卫在 §85 移入 `scripts/` 并把本条豁免收进唯一一处，对豁免根之外照常 fail-closed） | §84.6 / §85 |
- 工作树的 `packages/dsh-plugin-tidychat/**` 处于**删除态**（`git status --porcelain` 显示 14 个 `D`），
  与根 `AGENTS.md`"tidychat 放弃折叠与导航、不得做第二 owner"的方向一致；该删除不在本文件写集内。
- 同批还有一份 `docs/2.0.18/native-transcript-owner.md`（tidychat 退役的能力清单）。两者分类不冲突：
  那份按 tidychat 的 11 项能力分类，本文件按 turn-fold README 的 16 条用户可见行为分类，交集处结论一致
  （折叠 / 推理行 / 摘要指标 / 导航 = 原生已有）。
- **工作树与 HEAD 不一致（本次实测，供主代理裁决）**：HEAD `bbdd51ea65` 里 Path C 资产命中数为 **0**，但本会话期间
  `packages/dsh-plugin-{turn-fold,harmony}/` 与 `upstream/plugins/dsh-{turn-fold,harmony}/` 又**以未跟踪文件出现**（并发工作）。
  即「提交态 = 已撤回、工作树 = 又在树里」。本文件对这件事**不作裁决**，只报告；§4 的测量对两者都成立。
- 本文件**不改代码、不提交**，也不重建 turn-fold/harmony。

---

## 6. 离线不可验证的部分

1. **实机可见性未验**：原生摘要条、右侧导航轨、usage/time pill 在**打包后的 e-Mate** 里是否真的显示，
   本文件只做到源码级 + Profile 挂载级取证（`desktop/e-mate-desktop/src/e-mate-profile.ts:648, 752` 挂 `@deepseek-ai/dsh-web-app`；
   `upstream/deepseek-harness/packages/bundle/web-app/cordis.patch.yml:249-256` 挂 `ui-conversation` + `ui-chat`；
   e-Mate 全仓无 `transcriptView` 覆盖 ⇒ 默认 `compact` 生效，`ui-chat/src/chat-settings.ts:18`）。
   实机核对按 calibration 走 computer use。
2. **插件在 0.1.5 上的实际渲染未验**，且**目前不可验**：需要 `dsh-harmony@0.8.10` 运行时，而它在 0.1.5 下
   import 不起来（缺 `@deepseek-ai/dsh-atomic-write`、`tsquery`、`magic-string`、`semver`、`typescript`；§77.5 / §78.2）。
   本文件因此只断言**选择器可行性**，不断言改写后的语法正确性或运行时行为。
3. **B14 的"响应式换行"是源码级判断**（`nowrap` + `ellipsis`），未见实机在窄宽度下的表现。
4. 本文件未跑 `pnpm run test:fast` / `component-run check`：写集只允许 `docs/2.0.18/**`，本次没有任何代码或清单改动，
   故无对应门禁可跑。

---

## 7. 本次实际执行的命令（可复核）

```sh
# 定位
cd <worktree> && pwd && git rev-parse HEAD && git log --oneline -3 && git status --porcelain
cat desktop/e-mate-desktop/base-contract.json
cd upstream/deepseek-harness && git rev-parse HEAD
# 历史证据
git show --stat --oneline 3c8042caee | head -60
git show --stat --oneline 04b43379f4 | head -60
git show 04b43379f4:packages/dsh-plugin-turn-fold/scripts/seams.mjs
git show 04b43379f4:packages/dsh-plugin-turn-fold/test/seams.test.mjs   # 测试名/断言
git show 3c8042caee:upstream/plugins/dsh-turn-fold/README.md           # 规范 (2)
git show 3c8042caee:upstream/plugins/dsh-turn-fold/SOURCE.md
git show 3c8042caee:upstream/plugins/dsh-turn-fold/package.json        # peer 区间
git show 3c8042caee:upstream/plugins/dsh-turn-fold/settings.cjs        # SUMMARY_FIELDS
git log --oneline -1 b1357ced55 && git show --stat --oneline b1357ced55 | head -20
git ls-tree -r --name-only HEAD | grep -c 'dsh-plugin-turn-fold|upstream/plugins/dsh-turn-fold|dsh-plugin-harmony'   # → 0
# 活体规范核对（web_fetch 在本机被 DNS 策略拒绝，改用 curl）
curl -sSL -o /tmp/tf-readme-live.md https://raw.githubusercontent.com/CH4ACKO3/dsh-turn-fold/main/README.md
shasum -a 256 /tmp/tf-readme-live.md /tmp/tf-readme-vendored.md && diff /tmp/tf-readme-vendored.md /tmp/tf-readme-live.md
# 接缝复跑（见 §4.1）
EMATE_HARNESS_ROOT=<worktree>/upstream/deepseek-harness node /tmp/tf-seamcheck/scripts/seams.mjs
# 原生取证（grep / sed / 读取）
grep -rn "compactTranscript|useChatNodeProcess|turnProcess" upstream/deepseek-harness/packages/client/{ui-chat,ui-conversation}/src
grep -rn "branchUnavailable|compactAnswer|interrupted|transcriptView|conversation.chat.node|conversation.chat.turnTail" <多处>
sed -n '...p' upstream/deepseek-harness/packages/client/ui-chat/src/...   # 逐文件读取（见 §2 引用行）
grep -rn transcriptView packages desktop      # e-Mate 侧零命中
```
