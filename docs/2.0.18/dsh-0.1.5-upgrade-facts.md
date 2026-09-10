# e-Mate 2.0.18 → DSH 0.1.5-rc.1 基线升级：实测事实与工作清单

本文件记录**实测结论**，不是计划叙述。每条都可由文末命令复现。
版本号按用户指示保持 `2.0.18`，不跳号。

## 1. 基线固定点

| 项 | 现在 | 目标 | 来源 |
|---|---|---|---|
| DSH 内核 | 0.1.0-rc.7 | **0.1.5-rc.1** | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` |
| e-Mate harness fork | `1d3824bcd3400b3761a0ebdd956901752ddc962b` | 重定基后的新 fork SHA（待产出） | — |
| 桌面参考 | `anywhere-labs/deepseek-harness-desktop@6074088f5b660206e404b3591fab51fb99c69add`（08-19） | `anywhere-labs/dsh-desktop@166c16cfc38c51d32c2316715548c0f8271db517`（09-10，master） | 用户选定 master |
| cordis | 4.0.1 | **4.0.2** | 上游 master `dsh-plugin-desktop` deps |
| pnpm | 11.7.0 | 待定（上游 master 用 11.8.0 + patch） | 需决策 |
| yarn (desktop) | 4.18.0 | 4.18.0（不变） | 上游一致 |

上游 master 自带 `vendor/dsh-runtime/0.1.5-rc.1/`：**265 个 tgz + manifest.json**，manifest 锁定 commit/version/buildProfile，可直接作为供应来源。
`vendor/dsh-runtime/0.1.5-rc.1/manifest.json → commit = 183f08e9…, version = 0.1.5-rc.1, buildProfile = official`。

## 2. 关键结构性事实：e-Mate 不是 dsh-desktop 的 fork

| 项 | 数量 |
|---|---|
| e-Mate 2.0.18 文件 | 1643 |
| 上游 master 文件 | 1373 |
| **路径重合的文件** | **9**（全部是仓库级治理/配置：`.gitattributes` `.github/workflows/ci.yml` `.gitignore` `.gitmodules` `AGENTS.md` `LICENSE` `README.md` `docs/architecture.md` `package.json`） |
| e-Mate 独有 | 1634（883 插件 + 127 `packages/dsh` + 289 desktop + 184 enterprise + 22 scripts + 129 docs/skills/tests） |

**结论**：e-Mate 是独立产品，**内嵌（vendor）** 了较老的上游桌面与 harness。
因此"换基"= 合并两个产品，而非薄增量回贴。**本次采用原地升级**（用户 2026-09-10 确认）：保留 e-Mate 树，只换基线。
换基基点已建好并**停用留档**：工作树 `worktrees/emate-2.0.18-dsh015-rebase`、分支 `feat/2.0.18/dsh-0.1.5-rebase`、提交 `aaa8c45256`（e-Mate 祖先可达 + 上游树）。它的实际用途是**离线读上游源码的参照树**。

## 3. harness fork 的真实 delta：21 个提交

`99f6f02f..1d3824bcd340` = **21 个提交 / 201 文件 / +7128 -1017**。
`99f6f02f`（rc.7）**仍是** `183f08e9`（0.1.5-rc.1）的祖先，中间隔 **3964 个提交**，线性无分叉。

> 注意：AGENTS.md 中"fork 只多了 session-draft 隔离"是相对 `b469c2b99a6c` 的说法，**不是**相对上游。相对上游是 21 个提交。

改动按区域：`ui-conversation`(20) `schedule`(17) `apiproxy`(12) `ui-user-questions`(12) `scripts`(9) `user-questions`(8) `jobs-local`(7) `jobs`(6) `core/tools`(6) `ui-attachment`(6) `client/runtime`(6) `tool-pwsh`(5) `tool-bash`(5) `ui-model-selection`(5) `core/session`(3) 等。

### 3.1 patch-id 判据不可用
`git cherry 183f08e9 1d3824bcd340` 显示 **21 个全部为 `+`（缺失）**。但实测 `hero` 与 `draft` 相关符号在 0.1.5 中**已存在**，`composer-frame` 不存在。
**结论：patch-id 相同 ≠ 语义相同，必须逐提交按语义判定。**

### 3.2 逐提交符号比对结果（启发式，需用各自测试复核）

**判定为 0.1.5 已有等价实现（可优先验证后废弃）：**
- `fix(ui): make attachment drop overlay dismissible (#1)`（3/3）
- `fix(models): refresh directories after credential commits`（2/2）
- `docs(imagegen): refresh review contracts`（1/1，纯文档）
- `fix(conversation): expose semantic composer frame host`（3/3）
- `fix(conversation): isolate session drafts on workspace switch`（1/1）

**判定为需重做（按缺口大小排序）：**
| 提交 | 命中 | 关注点 |
|---|---|---|
| `test(schedule): make downgrade gate hermetic` | 0/3 | schedule 降级门禁 |
| `fix(settings): expose stable section ids` | 0/1 | settings 分区 id 稳定性 |
| `fix(schedule): make reminder delivery crash safe` | 1/3 | schedule 投递 |
| `fix(schedule): make delivery rollback fail closed` | 1/3 | schedule 回滚 |
| `test(schedule): gate built downgrade compatibility` | 1/3 | schedule |
| `feat(schedule): gate delivery startup admission` | 1/3 | schedule 启动准入 |
| `fix(schedule): honor startup delivery admission` | 1/3 | schedule |
| `feat(tools): expose registration provenance` | 1/3 | Tool 注册来源 |
| `feat(jobs): add cross-owner kind admission` | 1/3 | jobs 准入 |
| `fix(jobs): register queued admission jobs` | 2/3 | jobs |
| `fix(jobs): close queued owner teardown race` | 2/3 | jobs |
| `fix(session): isolate corrupt cold list artifacts` | 1/3 | 冷列表损坏隔离 |
| `feat(imagegen): gate image edits on native review` | 1/3 | **生图编辑原生复核**（与生图验收直接相关） |
| `feat(llm): add registration-bound wire transform` | 2/3 | llm 线上变换 |
| `feat(ui-conversation): add declarative hero content slot` | 2/3 | 首页 hero 槽（e-Mate 外壳依赖） |
| `test(client): repair image review fixtures` | 0/0 | 测试专用 |

**冲突特征**：试重放时冲突集中在 **README/i18n 样板**（`README.md`/`README.zh.md`/`README.i18n.yaml`）与 `ui-conversation/src/client/skeleton/InputBar.tsx`。
0.1.5 的 `ui-conversation` 已重构为 `contract/` `conversation/` `input/` `skeleton/` 分层，rc.7 的扁平结构不再对应——**这是结构性重写，不是补丁级合并**。

## 4. G0 固定点清单（已逐处定位）

| 文件 | 需改动 |
|---|---|
| `scripts/harness-provenance.mjs` | `HARNESS_COMMIT`、`HARNESS_VERSION`，以及 `DESKTOP_OVERLAYS` 中 4 条 patch 路径（文件名含 `0.1.0-rc.7`） |
| `desktop/upstream.json` | `commit` 99f6f02f→183f08e9、`sourceVersion`/`runtimePackageVersion`→0.1.5-rc.1 |
| `desktop/e-mate-desktop/base-contract.json` | `id`（`…-v18-dsh-4da69d7c3522`）、`harness_version`、`harness_commit`、`desktop_reference.{commit,harness_commit,harness_version}`、22 项 `runtime_imports` 全量重导 |
| `scripts/component-run.mjs` | 2 处断言（`harness_version` + `harness_commit`）+ `manifest.eMate.harnessVersion` |
| `scripts/version-contract.test.mjs` | `contract.id`、`contract.harness_version`；**版本 2.0.18 断言保持不变** |
| `desktop/patches/*` | 4 个 patch（`dsh-app-boot` `dsh-client-ui-workspace` `dsh-sandbox-windows-acl` `app-builder-lib@26.15.7`）按 0.1.5 重生或删除 |
| `desktop/.yarn/patches/` | `@deepseek-ai-dsh-tool-fs-npm-0.1.0-rc.7-redundant-escalation.patch` 需重做 |
| `AGENTS.md` / `docs/target-contract.md` | 删除"用户已取消 0.1.5 迁移""任何 rc.8 依赖都是契约失败"，写入新基线与本次授权 |
| 全部 26 个 package.json | **保持 2.0.18 不动**（已被 `version-contract.test.mjs` 断言） |

## 5. 真正的兼容面：6 个 harness 源码适配器

`scripts/` 下这些模块靠**字符串手术**在 harness 源码上开缝，且**找不到接缝即抛错关闭**（这是优点：不会静默产生坏构建）：

| 模块 | 行数 | 作用 |
|---|---|---|
| `harness-conversation-adapter.mjs` | 375 | 保留 rc.7 失败投影与渲染器，暴露权威 `turn/end` |
| `harness-artifact-links-adapter.mjs` | 208 | 产物链接 + 渲染器 |
| `harness-session-export-adapter.mjs` | 132 | 会话导出接缝 |
| `harness-runtime-adapters.mjs` | 79 | fs 升级接缝、自动标题接缝 |
| `harness-fs-bytes-adapter.mjs` | 64 | 替换 `readWholeBytes` |
| `harness-slot-error-adapter.mjs` | 15 | 槽位错误接缝 |

内核升级后这 6 个**逐个重 derive 或删除**，是本次升级工作量的主要部分之一。

## 6. 未集成的 7 个分支（`git cherry` 按 patch-id 判定）

| 分支 | 未集成提交 | 主题 |
|---|---|---|
| `agent/gallery-native-receipts-2.0.16` | 34 | render native child image receipts |
| `agent/gallery-projection-cold-hydration` | 33 | stream native child image receipts |
| `release/2.0.15-final-regression-batch-r2` | 13 | computer-use zod ABI 等 |
| `fix/2.0.15-T08R4-share-profile-contract` | 11 | share revoke 契约 |
| `fix/2.0.18/image-tail` | 1 | **retain artifacts after failed follow-up turns**（已补提交 `feaabaf5`） |
| `feat/2.0.18/canvas-assets-performance` | 1 | canvas 复用已验证文件 |
| `fix/enterprise-arco-react19` | 1 | 企业 admin Arco React 19 |

其余 19 个非祖先分支（含 `request-size`、`image-negative-edit`、`image-route-compat`、各 knowledge/xin）**已以等价补丁进基线**，不得重复搬。

## 7. 版本号与发布路径（用户决定）

- **版本保持 2.0.18**，26 个 package.json 不动；`version-contract.test.mjs` 已断言。
- 2.0.18 **从未公开发布**（`deploy/download-page/*.html` 仍指向 `data-desktop-version="2.0.16"`，且测试断言**禁止**该页面出现 2.0.18）。
- 因此分发走**同版本替换**（官方手动下载页路径），**不走自动更新**——原生更新器只接受严格更新的稳定版本。

## 8. 复现命令

```sh
# 基线文本
git -C worktrees/emate-2.0.18-rc7-tidychat log -1 --oneline            # 3cc4be84
git tag -l 'safety/*'

# 上游基线
git -C /Users/mac/e-mate/repo log -1 upstream/master                   # 166c16cf
git -C /Users/mac/e-mate/repo show upstream/master:upstream.json       # 0.1.5-rc.1 / 183f08e9

# 树重合度
git -C /Users/mac/e-mate/repo worktree list
git ls-tree -r --name-only 3cc4be84 > /tmp/e.txt; git ls-tree -r --name-only <upstream-tree> > /tmp/u.txt
comm -12 /tmp/e.txt /tmp/u.txt | wc -l                                 # 9

# harness fork delta
cd worktrees/emate-2.0.18-rc7-tidychat/upstream/deepseek-harness
git rev-list --count 99f6f02f..1d3824bcd340                            # 21
git cherry -v 183f08e9 1d3824bcd340                                    # 全部 '+'
git merge-base --is-ancestor 99f6f02f 183f08e9 && echo linear

# 未集成分支
git cherry feat/2.0.18/rc7-tidychat <branch>
```

---

## 9. 在线更新硬约束（用户要求：2.0.16 / 2.0.17 用户必须能在线更新到 2.0.18）

### 9.1 现有在线更新链（实测，全部与内核无关）

| 环节 | 实现 | 是否受本次升级影响 |
|---|---|---|
| 版本检查端点 | `update-checker.ts` → `DESKTOP_VERSION_ENDPOINT = https://pub-ada3f610c0234a76838f4e19fe2bb25e.r2.dev/desktop/version.json` | **否** |
| 请求 | GET + `X-e-Mate-Version` + 安装 ID header，`redirect: error`，4 KiB 上限 | **否** |
| 响应 | `{ "version": "<stable semver>" }` | **否** |
| 判定 | 严格 SemVer 比较：**仅当 latest > current** 才 `update-available` | **否** |
| 下载地址 | `DESKTOP_DOWNLOAD_URLS`：`…/desktop/downloads/mac` 与 `…/desktop/downloads/windows`（**固定，不随版本变化**） | **否** |
| 文件名 | `e-Mate-<version>-<platform>.dmg|.exe` | **否** |
| 产物校验 | 稳定 SemVer（禁止 prerelease）+ dmg / PE 校验 | **否** |
| 更新服务实现 | `candidate-update-worker.mjs`：`/desktop/version.json` 直接返回 `manifest.version` | **否** |

**结论：整条链是"候选清单 version 字段"的纯函数，不依赖 DSH 版本、cordis 版本、base-contract id 或 profile 格式。**

### 9.2 为什么 16/17 → 18 天然成立
- 端点与下载 URL 常量自 `f876f01d82`（**2.0.16 发布提交，2026-09-03**）引入后**从未改动**：`git log f876f01d82..HEAD -- desktop/e-mate-desktop/src/update-checker.ts desktop/e-mate-desktop/src/update-download.ts` 为空。
- 因此 2.0.16、2.0.17、2.0.18 基线共用同一端点与同一 URL 约定。
- 2.0.18 > 2.0.16、2.0.18 > 2.0.17 均为**严格更新**，在线更新路径直接成立。
- 保持版本号 **2.0.18**（而非跳号）使这条需求无需任何额外机制。

### 9.3 发布时必须同时做到（否则需求不成立）
1. `desktop/version.json` 返回 `{"version":"2.0.18"}`；
2. `/desktop/downloads/mac` 提供 2.0.18 的 **macOS universal DMG**；
3. `/desktop/downloads/windows` 提供 2.0.18 的 **NSIS 安装程序**；
4. 文件名严格为 `e-Mate-2.0.18-mac.dmg` / `e-Mate-2.0.18-win.exe` 形式；
5. 版本号必须是**稳定版**（不可带 prerelease）。

### 9.4 本机 2.0.18 测试机构不能走在线更新
本机已装 2.0.18 候选，目标是另一个 2.0.18 → `latest == current` → `up-to-date`，**不会提示更新**。
这是**同版本替换**场景，走官方手动下载页路径，不是用户面对的路径，也不得为其新增第二条 feed。

### 9.5 不得触碰
`update-checker.ts` 与 `update-download.ts` 的端点/URL/文件名/校验逻辑**在本次升级中保持零改动**。

---

## 10. desktop 补丁逐条核对（对 0.1.5 真实编译产物实测）

方法：从 `vendor/dsh-runtime/0.1.5-rc.1/*.tgz` 解出四个包的 `lib/*.js`，逐个核对补丁目标站点是否仍存在、0.1.5 是否已自带。

| e-Mate 补丁 | 意图 | 0.1.5 现状 | 裁决 |
|---|---|---|---|
| `dsh-app-boot@0.1.0-rc.7.patch` | `parsePatchList` 容忍空/缺省 patch 列表 | `lib/index.js:1199` **仍是** `if (!Array.isArray(parsed)) throw`，无 void 0/null 容忍 | **保留，按 0.1.5 重做**（行号 840→1199） |
| `dsh-client-ui-workspace@0.1.0-rc.7.patch` | 给工作区浏览器根节点加 `data-dsh-workspace-drop-target` | `lib/client.js:2222` **仍是** `className: clsx(WorkspaceBrowser_module_css_default.root, …)`，**无** 该标记 | **保留，按 0.1.5 重做**（行号 1849→2222） |
| `dsh-sandbox-windows-acl@0.1.0-rc.7.patch` | `dwFlags: 256→257` + `wShowWindow: 0`，隐藏 Windows 控制台窗口 | **目标代码已搬走**：0.1.5 把 spawn 逻辑抽到新包 `@deepseek-ai/dsh-win32-process`；`sandbox-windows-acl` 只剩转发（`spawnPipedProcess(api, {…options, token})`）。`dwFlags` 现位于 `dsh-win32-process/lib/index.js:392` 与 `:536` | **删除自有补丁，改用上游 `dsh-win32-process@0.1.5-rc.1.patch`** |
| `.yarn/patches/@deepseek-ai-dsh-tool-fs-npm-0.1.0-rc.7-redundant-escalation.patch` | 冗余提权免 justification | `lib/index.js:1189` **仍是** `validateEscalationArgs(args.sandbox_permissions, args.justification)`，**无** `redundantEscalation` | **保留，按 0.1.5 重做**（行号 1117→1189） |

### 10.1 换用上游补丁的证据
上游 `patches/dsh-win32-process@0.1.5-rc.1.patch` 的改动与 e-Mate 原意图**同义**：

```diff
@@ spawnPipedProcess   cb: 104, -dwFlags: 256, +dwFlags: 257, +wShowWindow: 0
@@ spawnJobProcess     cb: 104, -dwFlags: 256, +dwFlags: 257, +wShowWindow: 0
```

与 e-Mate 原补丁的两处站点（`spawnSandboxed` / `spawnSandboxedInherited`）一一对应；0.1.5 中 `wShowWindow` 的类型条目 `uint16` 也已存在（`lib/index.js:48`）。
**结论：e-Mate 不再需要维护这个补丁，直接采纳上游版本。**

### 10.2 上游 app-boot 补丁不是同一件事
上游 `dsh-app-boot@0.1.5-rc.1.patch`（4152 字节）改的是 `healProfilesModuleFallback` / `dependencyClosure` / asar 解析器归属，**与 `parsePatchList` 空列表容忍无关**，不能替代 e-Mate 的补丁。

### 10.3 重做补丁的正确路径
这些补丁打的是**编译产物 `lib/*.js`**，unified diff 带 blob hash，**不得手工改行号或 hash**。正确顺序：
1. `desktop/package.json` resolutions 升到 `@0.1.5-rc.1`；
2. 在 desktop 工作区完成 0.1.5 的 yarn install（lockfile 同步重生）；
3. 用 `yarn patch <pkg>` → 编辑 → `yarn patch-commit` 重新生成补丁；
4. 之后才更新 `harness-provenance.mjs` 的 `DESKTOP_OVERLAYS` 路径名。

**顺序不可颠倒**：先改引用名会指向内容已不适用的补丁，形成静默坏构建。

---

## 11. desktop 依赖面迁移图（rc.7 → 0.1.5，实测生成）

来源：`desktop/e-mate-desktop/package.json` 的依赖 vs `vendor/dsh-runtime/0.1.5-rc.1/manifest.json` 供应 vs 上游 `dsh-plugin-desktop/package.json`。

| 项 | 数量 |
|---|---|
| e-Mate desktop 声明的 dsh 依赖 | 101 |
| 上游 0.1.5 desktop 声明的 dsh 依赖 | 135 |
| 0.1.5 供应包总数 | 265 |

### 11.1 必须改名或删除（e-Mate 声明，0.1.5 已无此包）

| 包 | 上游 0.1.5 的对应物 |
|---|---|
| `@deepseek-ai/dsh-client-runtime` | 疑似 @deepseek-ai/dsh-client-store（待按实际消费确认） |
| `@deepseek-ai/dsh-client-schema-form` | 0.1.5 无同名包（疑似并入 client-ui-primitives） |
| `@deepseek-ai/dsh-client-web-react` | 疑似 @deepseek-ai/dsh-client-web |
| `@deepseek-ai/dsh-host-apiproxy` | 疑似 @deepseek-ai/dsh-http-proxy |

### 11.2 e-Mate 独有、上游 desktop 未声明（5 个）

- `@deepseek-ai/dsh-client-runtime`
- `@deepseek-ai/dsh-client-schema-form`
- `@deepseek-ai/dsh-client-web-react`
- `@deepseek-ai/dsh-host-apiproxy`
- `@deepseek-ai/dsh-schedule`

### 11.3 0.1.5 新增、e-Mate 尚未声明（39 个）

- `@deepseek-ai/dsh-agent-instructions`
- `@deepseek-ai/dsh-agent-loop`
- `@deepseek-ai/dsh-api-session-controller`
- `@deepseek-ai/dsh-api-settings-controller`
- `@deepseek-ai/dsh-api-workspace-controller`
- `@deepseek-ai/dsh-authorization`
- `@deepseek-ai/dsh-client-file-upload`
- `@deepseek-ai/dsh-client-store`
- `@deepseek-ai/dsh-client-ui-approval`
- `@deepseek-ai/dsh-client-ui-chat`
- `@deepseek-ai/dsh-client-ui-renderer`
- `@deepseek-ai/dsh-client-ui-session`
- `@deepseek-ai/dsh-client-ui-trajectory`
- `@deepseek-ai/dsh-deepseek-llm-api-extensions`
- `@deepseek-ai/dsh-file-reference`
- `@deepseek-ai/dsh-goal-round-driver`
- `@deepseek-ai/dsh-hook-protocol`
- `@deepseek-ai/dsh-http-proxy`
- `@deepseek-ai/dsh-jobs-local`
- `@deepseek-ai/dsh-llm-deepseek`
- `@deepseek-ai/dsh-mcp-client`
- `@deepseek-ai/dsh-native-command`
- `@deepseek-ai/dsh-sandbox-local`
- `@deepseek-ai/dsh-sdk-protocol`
- `@deepseek-ai/dsh-session-persistence-jsonl`
- `@deepseek-ai/dsh-session-reference`
- `@deepseek-ai/dsh-subprocess-local`
- `@deepseek-ai/dsh-terminal-bash`
- `@deepseek-ai/dsh-tool-bash`
- `@deepseek-ai/dsh-tool-goal`
- `@deepseek-ai/dsh-tool-jobs`
- `@deepseek-ai/dsh-tool-pwsh-persistent`
- `@deepseek-ai/dsh-tool-skill`
- `@deepseek-ai/dsh-tool-todo`
- `@deepseek-ai/dsh-util-crypto`
- `@deepseek-ai/dsh-util-time`
- `@deepseek-ai/dsh-util-values`
- `@deepseek-ai/dsh-util-workspace-path`
- `@deepseek-ai/dsh-webhook`

### 11.4 框架版本（必须跟上游）

| 包 | e-Mate 现用 | 上游 0.1.5 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.1 | 4.0.2 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.1 | 1.0.2 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.6 | 1.0.7 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.2 | 1.0.3 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.3 | 1.1.4 |
| `@deepseek-ai/schemastery` | 3.18.1 | ^3.18.2 |

### 11.5 结论

- 依赖面不是"改个版本号"：**4 个包要改名/删除，39 个包要新增**。
- `@deepseek-ai/dsh-client-ui-trajectory` 出现在上游 0.1.5 的 desktop 依赖里 —— 与"还原原生工具调用链"直接呼应。
- 新增项含 client-ui-chat / client-file-upload / mcp-client / tool-skill / jobs-local / session-persistence-jsonl，是"原生优先替换"的候选来源。
- 改名必须与 harness 子模块重定基同步落地，否则 npm 声明与本地构建 runtime 不一致，`verify-desktop` 会失败。
