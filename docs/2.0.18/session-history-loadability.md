# 2.0.16/2.0.17 会话历史在 0.1.5-rc.1 上的可读性：实测与修复

本文件只记录**实测结论**与可复现命令。结论来自本机真实用户会话数据，读写过程**从不修改既有会话文件**。

## 1. 结论（一句话）

升级到 0.1.5-rc.1 后，**153 条 2.0.16/2.0.17 真实会话里原本只有 26 条能打开**；修复 native released-v0 读取器后 **130 条可打开**。剩余 23 条属于三类**独立成因**，均判定为「不该由 released-v0 读取器承担」，按主代理裁决 stop-and-report（见 §4）。

## 2. 数据位置与记录字段

| 项 | 值 |
|---|---|
| 会话根 | `/Users/mac/Library/Application Support/DeepSeek Harness Official/home/sessions`（237 MB） |
| e-Mate 工作区目录 | 同根下 `--Users-mac-e-mate--` |
| 历史代（2.0.16/2.0.17 写入） | `session.jsonl.zstd`，header `{"type":"session","version":0,...}` |
| 当前代（0.1.5-rc.1 写入） | `session.v3.jsonl.zstd`，header `{"type":"session","version":3,...}` |

物理容器是**拼接的、带校验和的 zstd 帧**（一次 flush 一帧，41 MB 的文件有 2863 帧），不是单个 zstd 流；因此 `zlib.zstdDecompressSync` 只能解出第一帧，必须逐帧扫描（`packages/session/session-persistence-jsonl/src/zstd.ts` 的 `scanZstdFrames` 即此逻辑）。

## 3. 可读性普查（153 条 v0-only 记录）

| 类别 | 修复前 | 修复后 |
|---|---|---|
| **LOADED** | **26** | **130** |
| `subagent/descriptor ... unsupported descriptor version 2` | 104 | 0 |
| `format v2 surface before first step ...` | 15 | 15 |
| `user/message source has unexpected member "batchId"` | 6 | 6 |
| `step/end leaves unresolved tool call` | 2 | 2 |
| 合计 refused | 127 | 23 |

读取路径：把真实 `session.jsonl.zstd` 复制进临时 root，用**出货的读取器**（`JsonlSessionPersistence`，`compression: 'zstd'`）经 vitest（tsconfig paths → `src`）打开。

**正向对照（证明仪器有效）**：升级后的 2 条 `session.v3.jsonl.zstd` 在同一仪器下 LOADED（16930 / 807 事件）。

## 4. 逐因判定

### 因 1：`subagent/descriptor` version 2 —— 读取器 bug，已修

- 拒绝点：`packages/session/session-format-v0-to-v1/src/validation.ts:198`（`data['version'] !== 3`）与 `src/payload-validation.ts:956`（`literalValue(data['version'], [3], ...)`）。
- 证据：本机**全部 155 条 v0 记录中共 104 个 descriptor，无一例外都是 version 2**（102 continuable/spawn + 2 one-shot/spawn），**version 3 只出现在升级后的 20 条 v3 记录里**（11 个，全部为 3）。
- 写入方时间线（fork 内 git）：`774ee34b9a`（2026-07-27）引入 `SUBAGENT_DESCRIPTOR_VERSION = 2`；`f76a225a7d`（2026-08-24）改为 `3`。而 `SESSION_FORMAT_VERSION` 直到 `d1521ea783`（2026-08-31）才从 0 变为 1。
- 即：**v0 世代内 descriptor 从 2 走到 3**，两种值都是已发布写入方真实写出的。读取一个已发布世代时必须接受该世代真正写过的值。
- 修复：把接受集**枚举**为 `{2, 3}`，集合之外仍旧拒绝（未放宽为「任意版本」）。

### 因 2：surface 在首个 step 之前（15 条）—— 非 native 形态，需 e-mate 侧修

15 条的 id **全部是 `legacy-*`**（例如 `legacy-8380abc1…`），是 e-Mate 自身的 `profiles/e-mate/plugins/legacy-migration.js` 从旧 e-Mate 存储**合成**的 v0 文件（该插件里写死 `const SESSION_FORMAT_VERSION = 0`），不是 0.1.0-rc.7 原生写出的会话。它们的时间线是 `turn/start → user/message → step/start`。

原生写入方从不产出该形态：本机 **138 条 native v0** 与 **20 条 v3** 记录全部是 `step/start` 在前。v2→v3 的拒绝（`session-format-v2-to-v3/src/migration.ts:57`）是上游**刻意的时序护栏**（上游自带 fixture `released-v0-real-shapes.jsonl` 断言该形态必须被拒）。要在 packages/session 内"修"它就得凭空改写入时序。

**判定：不改**。正确修点在 e-mate 的 `legacy-migration.js`（导入时先落 `step/start` 或 system 头），**在我的写集之外**，按裁决 stop-and-report。

### 因 3：`source.batchId` / `historyHandledBy`（6 条）—— 第三方插件越界，需第三方修

拒绝点：`src/payload-validation.ts:632` `pluginSourceValue` 的封闭可选集 `['form','sections','summary']`。

写入方是 **`dsh-universal-attachments`**：该插件既不在上游 `packages/`，也不在 e-mate 仓库中（属第三方插件市场来源），它把 `batchId`/`historyHandledBy` 塞进了 `user/message.source`。这两个成员**不存在于任何 DSH 世代的 source 词汇表**（上游全树 grep `batchId` 为 0 命中）。

**判定：不改**。这是第三方插件写了格式外成员，不是读取器与该世代写入方不一致；修点在插件侧（或需上游先定义一个成员），**在我的写集之外**，stop-and-report。

### 因 4：`step/end leaves unresolved tool call`（2 条）—— native，但属格式完整性决策

2 条都是 native（`session-4ddc5551…`、`session-770b7d32…`）。形态：`tool/call`（advertised）→ `step/end`（无 `tool/result`）→ `turn/end` 且 `reason.kind = "error"`（该轮在派发工具前就崩了，报 `Cannot read properties of undefined (reading 'prepare')`）。

拒绝点：`src/relationships.ts:124 / 109` → `assertNoUnresolvedTools`（`relationships.ts:375-380`）。上游只承认一种"被中断工具调用"的精确修复形态（`isExactToolNotStartedRepair`，`error.name === 'ToolNotStartedError'`）；本机两条没有该修复结果。

**判定：不改，需上游格式完整性决策**。放宽它意味着 v3 产物里可能留下悬空的 advertised call，影响投影与续跑语义，不属于"读取器接受已发布写入方的常量"这类无争议修复。已上报主代理。

## 5. 改动

harness fork 内（submodule `upstream/deepseek-harness`，commit 见交付报告）：

| 文件 | 改动 |
|---|---|
| `packages/session/session-format-v0-to-v1/src/validation-helpers.ts` | 新增 `RELEASED_V0_DESCRIPTOR_VERSIONS = new Set([2, 3])`（含理由 JSDoc） |
| `packages/session/session-format-v0-to-v1/src/validation.ts:198` | `!== 3` → 不在枚举集内才拒绝 |
| `packages/session/session-format-v0-to-v1/src/payload-validation.ts:956` | `literalValue(data['version'], [3], …)` → 枚举集 |
| `packages/session/session-format-v0-to-v1/tests/fixtures/released-v0-subagent-descriptor-v2.jsonl` | 真实产物**前两行逐字节拷贝**（header + descriptor v2），474 B |
| `packages/session/session-format-v0-to-v1/tests/released-descriptor-versions.spec.ts` | owner 侧枚举守卫（接受 2/3、拒绝 1/4、覆盖 2.0.17 世代、真实字节恢复） |
| `packages/session/session-persistence-jsonl/tests/released-v0-descriptor.spec.ts` | 端到端：read 不发布后继且源文件字节不变；write 发布 v3 后继且可重读 |

fixture 来源：`--Users-mac-e-mate--/396efefd-89f9-4888-9b1e-8df1d0528231/session.jsonl.zstd`（110814 B，sha256 `f32b091043d7309c9d01d2f416a8ae0ba3724ae5f441c023dcee5c832bc859a6`）的前 2 行，逐字节未改。

## 6. 复现

### 6.1 守卫与端到端（keyless，无外部依赖）

```sh
cd upstream/deepseek-harness
npx vitest run packages/session/session-format-v0-to-v1/tests/released-descriptor-versions.spec.ts
npx vitest run packages/session/session-persistence-jsonl/tests/released-v0-descriptor.spec.ts
```

### 6.2 守卫可失败证明

把 `RELEASED_V0_DESCRIPTOR_VERSIONS` 收窄为 `new Set([3])` 后重跑上面两条 → **4 条用例失败、exit 1**（`keeps covering the descriptor version the shipped 2.0.16/2.0.17 generation wrote`、`restores the recorded released artifact rows verbatim`，以及端到端 read/write 两条）。恢复为 `[2, 3]` 后全部通过。已实测。

### 6.3 真实数据普查（本机，只读）

普查器把每条真实 `session.jsonl.zstd` 复制进临时 root 后用出货读取器打开。复现步骤：在 submodule 内临时放置一个 spec，用 `Context.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })` 打开，`root` 取自 `EMATE_SESSION_SOURCE`。逐帧解压用 `src/zstd.ts` 的 `scanZstdFrames` + `decompressZstdFrame`（**不要**用 `zlib.zstdDecompressSync` 一次性解，只出第一帧）。

实测命令与退出码：

| 命令 | 结果 |
|---|---|
| `npx vitest run packages/session/session-{format-v0-to-v1,persistence-jsonl,format-catalog,format}` | exit 0，38 files / 1308 tests passed |
| `pnpm run test:fast`（e-mate 根） | 见交付报告 |
