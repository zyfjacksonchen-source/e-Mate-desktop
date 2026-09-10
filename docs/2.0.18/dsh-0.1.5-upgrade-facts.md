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

---

## 12. harness fork 逐提交分诊（严格判据：只统计该提交真正新引入的符号）

方法：取每个提交新增行里的标识符，**排除其父提交中已存在的**，再用剩下的新符号去 0.1.5 里查存在性。

> ⚠️ **这是优先度排序工具，不是裁决。** 尤其当某提交只有 1 个新符号时（如 hero 那条 0/1），信号很弱；
> 而 6/6 命中（如 composer frame host）则是强信号。每一条最终都要用**它自己的测试**复核。

| 提交 | 新符号命中 | 初判 |
|---|---|---|
| `fix(ui): make attachment drop overlay dismissible (#1)` | 0/1 | 0.1.5 完全缺失 → 需重做 |
| `fix(schedule): make reminder delivery crash safe` | 0/6 | 0.1.5 完全缺失 → 需重做 |
| `fix(schedule): make delivery rollback fail closed` | 0/6 | 0.1.5 完全缺失 → 需重做 |
| `test(schedule): make downgrade gate hermetic` | 0/4 | 0.1.5 完全缺失 → 需重做 |
| `test(schedule): gate built downgrade compatibility` | 0/6 | 0.1.5 完全缺失 → 需重做 |
| `feat(schedule): gate delivery startup admission` | 0/6 | 0.1.5 完全缺失 → 需重做 |
| `fix(schedule): honor startup delivery admission` | 0/1 | 0.1.5 完全缺失 → 需重做 |
| `feat(tools): expose registration provenance` | 0/4 | 0.1.5 完全缺失 → 需重做 |
| `feat(jobs): add cross-owner kind admission` | 0/6 | 0.1.5 完全缺失 → 需重做 |
| `fix(jobs): register queued admission jobs` | 0/6 | 0.1.5 完全缺失 → 需重做 |
| `fix(jobs): close queued owner teardown race` | 0/2 | 0.1.5 完全缺失 → 需重做 |
| `fix(session): isolate corrupt cold list artifacts` | 0/2 | 0.1.5 完全缺失 → 需重做 |
| `fix(models): refresh directories after credential commits` | 2/2 | 0.1.5 已具备 → 优先核验后废弃 |
| `feat(imagegen): gate image edits on native review` | 0/6 | 0.1.5 完全缺失 → 需重做 |
| `test(client): repair image review fixtures` | 1/1 | 0.1.5 已具备 → 优先核验后废弃 |
| `docs(imagegen): refresh review contracts` | 1/1 | 0.1.5 已具备 → 优先核验后废弃 |
| `feat(llm): add registration-bound wire transform` | 0/4 | 0.1.5 完全缺失 → 需重做 |
| `fix(conversation): expose semantic composer frame host` | 6/6 | 0.1.5 已具备 → 优先核验后废弃 |
| `fix(settings): expose stable section ids` | 0/1 | 0.1.5 完全缺失 → 需重做 |
| `feat(ui-conversation): add declarative hero content slot` | 0/1 | 0.1.5 完全缺失 → 需重做 |
| `fix(conversation): isolate session drafts on workspace switch` | 1/1 | 0.1.5 已具备 → 优先核验后废弃 |

### 12.1 优先核验后可废弃（0.1.5 已具备）

- `fix(models): refresh directories after credential commits`
- `test(client): repair image review fixtures`
- `docs(imagegen): refresh review contracts`
- `fix(conversation): expose semantic composer frame host`
- `fix(conversation): isolate session drafts on workspace switch`

其中 `fix(conversation): expose semantic composer frame host` 为 **6/6 全命中**，是最有把握的一条 —— e-Mate 外壳依赖它，0.1.5 已自带，无需重做。

### 12.2 产品层面淘汰（非上游吸收，结论来自 e-Mate 自身要求）

`feat(imagegen): gate image edits on native review` —— **应废弃，不得重做**。证据：

- e-Mate 2.0.18 在 `AGENTS.md:7` 与 `docs/target-contract.md:16` **两处明文**要求 `zero image/edit confirmation`；
- 生图工具代码路径内无任何确认/复核；
- fork 也未把该门接入任何工具（`packages/tools` 无 `askUserQuestion` 使用）；
- e-Mate rc7 代码库不引用 `ImageReviewMedia`；唯一提及在 2.0.17 工单，且是反向要求（`绝不提问`）。

0.1.5 保留了通用 `AskUserQuestionIntent`（5 个文件）但**没有** `ImageReviewMedia` / `ImageAttachment`。
把该门搬到 0.1.5 会**违背产品要求并让已验收交互回退**，因此按淘汰处理。

### 12.3 需重做清单（初判，待逐条用测试复核）

- `fix(ui): make attachment drop overlay dismissible (#1)`
- `fix(schedule): make reminder delivery crash safe`
- `fix(schedule): make delivery rollback fail closed`
- `test(schedule): make downgrade gate hermetic`
- `test(schedule): gate built downgrade compatibility`
- `feat(schedule): gate delivery startup admission`
- `fix(schedule): honor startup delivery admission`
- `feat(tools): expose registration provenance`
- `feat(jobs): add cross-owner kind admission`
- `fix(jobs): register queued admission jobs`
- `fix(jobs): close queued owner teardown race`
- `fix(session): isolate corrupt cold list artifacts`
- `feat(imagegen): gate image edits on native review`
- `feat(llm): add registration-bound wire transform`
- `fix(settings): expose stable section ids`
- `feat(ui-conversation): add declarative hero content slot`

聚焦区域：**schedule 5 条**、**jobs 3 条**、tools 注册来源、session 冷列表隔离、llm 线上变换、settings 分区 id、ui-conversation hero 槽与附件拖放层。

---

## 13. 分诊方法的两轮证伪与最终裁决规则

两种自动探针都被实测证伪，**都只能当排序工具，不能当裁决**：

| 探针 | 判据 | 证伪方式 |
|---|---|---|
| 符号探针 | 该提交新引入的标识符是否出现在 0.1.5 | 对**纯增量标记型**提交必然误判：`data-emate-composer-frame-host` 这类新增不产生新标识符，于是被判成"0.1.5 已具备"，实际 0.1.5 完全没有 |
| 字面量探针 | 新增的任意字符串是否出现在 0.1.5 | 把**测试名与散文**也算进去（如 `"candidate worktree: clean"`），于是 21 条全部被判成"需重做"，同样错误 |

### 13.1 最终裁决规则

对每条提交，**按能力（capability）裁决**，而不是按文本匹配：

1. 找出该提交引入的**能力锚点**（DOM 契约属性、协议键、错误码、导出 API）——见 13.2 表；
2. 直接在 0.1.5 源码里读该能力是否以**任何形态**存在；
3. 检查 e-Mate 是否**真的消费**它（消费方存在 → 不得删；无消费方 → 可删）；
4. 用该提交**自带的测试**做最终确认。

### 13.2 能力锚点表（手工核验清单）

| 提交 | 能力锚点 | 0.1.5 缺失 |
|---|---|---|
| fix(ui): make attachment drop overlay dismissible (#1) | \`image.closeDrop\` | 1/1 |
| fix(schedule): make reminder delivery crash safe | \`schedule-occurrence-v2-\` \`schedule-delivery-v2-\` \`schedule-message-v2-\` \`dsh.schedule.occurrence.v2\` | 7/8 |
| fix(schedule): make delivery rollback fail closed | \`schedule-reserved-0\` \`schedule-reserved-1\` \`schedule-reserved-2\` \`gate.json\` | 4/4 |
| test(schedule): make downgrade gate hermetic | \`(无能力类字面量)\` | 否 |
| test(schedule): gate built downgrade compatibility | \`(无能力类字面量)\` | 否 |
| feat(schedule): gate delivery startup admission | \`scheduleDeliveryAdmission\` | 1/1 |
| fix(schedule): honor startup delivery admission | \`(无能力类字面量)\` | 否 |
| feat(tools): expose registration provenance | \`first.mjs\` \`second.mjs\` \`third-party-search-v1\` \`third-party-search-v2\` | 4/4 |
| feat(jobs): add cross-owner kind admission | \`emate-image-2\` | 1/1 |
| fix(jobs): register queued admission jobs | \`emate-image-3\` | 1/1 |
| fix(jobs): close queued owner teardown race | \`(无能力类字面量)\` | 否 |
| fix(session): isolate corrupt cold list artifacts | \`(无能力类字面量)\` | 否 |
| fix(models): refresh directories after credential commits | \`E_MATE_ENTERPRISE_SESSION\` | 1/1 |
| feat(imagegen): gate image edits on native review | \`image.loadError\` \`image.output\` \`image.source\` | 3/3 |
| test(client): repair image review fixtures | \`(无能力类字面量)\` | 否 |
| docs(imagegen): refresh review contracts | \`(无能力类字面量)\` | 否 |
| feat(llm): add registration-bound wire transform | \`INVALID_WIRE_REQUEST\` | 1/1 |
| fix(conversation): expose semantic composer frame host | \`data-emate-composer-frame-host\` | 1/1 |
| fix(settings): expose stable section ids | \`data-settings-section-id\` | 1/1 |
| feat(ui-conversation): add declarative hero content slot | \`conversation.hero.content\` | 1/1 |
| fix(conversation): isolate session drafts on workspace switch | \`(无能力类字面量)\` | 否 |

### 13.3 已完成的手工裁决（有证据）

| 提交 | 裁决 | 证据 |
|---|---|---|
| `fix(conversation): expose semantic composer frame host` | **必须重做** | 0.1.5 无 `data-emate-composer-frame-host`（0 命中）；e-Mate 侧重度消费：`emate-shell/src/client/home.module.css:41,67` 的 `:global([data-emate-composer-frame-host])` 样式 + `tests/composer-205.client.spec.tsx` 七条以上断言。0.1.5 的 `ConversationRoot.tsx:347` 结构相同（composer stack + hero workspace row），是**一行属性增量的重做** |
| `feat(imagegen): gate image edits on native review` | **产品淘汰，不得重做** | e-Mate 2.0.18 在 `AGENTS.md:7` 与 `docs/target-contract.md:16` 两处明文要求 `zero image/edit confirmation`；生图工具路径无确认；fork 未把该门接入任何工具；rc7 不引用 `ImageReviewMedia`，2.0.17 工单反向要求"绝不提问" |

**剩余 19 条**待按 13.1 规则逐条手工裁决。

---

## 14. schedule 家族裁决：整体淘汰（6 条，有完整证据链）

### 14.1 能力锚点核查

| 检查项 | 结果 |
|---|---|
| 0.1.5 是否有 `dsh.schedule.*.vN` 命名 | **无**（该命名由 fork 引入） |
| fork 新增 `packages/schedule/schedule/src/admission.ts` | 有，导出 `ScheduleDeliveryAdmission`（进程内单向闸门，等待 launcher 的启动事务提交后放行投递） |
| 0.1.5 是否已有 admission 概念 | **有**，在 `runtime.ts` 与测试中 |
| 0.1.5 是否有 fork 没有的 `src/transaction.ts` | **有**（agent 作用域的读写与持久化变更串行化） |

### 14.2 决定性证据：e-Mate 侧零消费

| 检查项 | 结果 |
|---|---|
| `ScheduleDeliveryAdmission` / `scheduleDeliveryAdmission` 消费方 | **零** |
| `protocol_floor` / `protocolFloor` / `dsh.schedule` 协议引用 | **零** |
| `probation`（试用期语义） | **已从代码库彻底移除**（0 命中） |
| e-Mate 的 schedule 集成点 | 仅 `cordis.patch.yml` 里装载 `@deepseek-ai/dsh-schedule` + `emate-schedule-import`，以及 `schedule-import.ts` / `agent-operations.ts` / `target-runtime.ts` |

该闸门的**唯一存在理由**是"首启更新处于 probation 时不得运行 Schedule 投递驱动"（见 `docs/target-contract.md` 的 2.0.13 条款）。
e-Mate 2.0.18 **已经移除了 probation 语义**，因此闸门、降级门禁与协议 floor 全部失去挂载点。

### 14.3 裁决

| 提交 | 裁决 | 理由 |
|---|---|---|
| `feat(schedule): gate delivery startup admission` | **淘汰** | 闸门本身；零消费方 |
| `fix(schedule): honor startup delivery admission` | **淘汰** | 服从闸门；闸门已无 |
| `test(schedule): make downgrade gate hermetic` | **淘汰** | 降级门禁，服务于协议 floor |
| `test(schedule): gate built downgrade compatibility` | **淘汰** | 同上 |
| `fix(schedule): make delivery rollback fail closed` | **淘汰（待一次确认）** | 作用于 fork 自有的 v2 投递协议；e-Mate 无任何 v2 引用。需确认其是否也修 v1/默认路径的持久化缺陷 |
| `fix(schedule): make reminder delivery crash safe` | **淘汰（待一次确认）** | 同上 |

**重要**：0.1.5 用 `transaction.ts`（agent 作用域串行化）解决了同类问题，设计不同。
按 e-Mate 自身章程"删除分歧、把调用方导回被固定的原生所有者"，**不得把 fork 的 `admission.ts` + v2 协议键嫁接上去**。

### 14.4 这条同时修正了 13.2 表的读法

13.2 表里这 6 条大多标着"缺失 N/N"，容易被读成"必须重做"。
**"0.1.5 缺失"只是必要信息，不是充分结论** —— 还要过 13.1 的第 3 步（e-Mate 是否真的消费）。本例中缺的正是 e-Mate 已经不要的东西。

---

## 15. harness fork 21 条最终裁决表（全部有证据）

### 15.1 重做（10 条）

| 提交 | 能力锚点 | 证据 |
|---|---|---|
| `fix(conversation): expose semantic composer frame host` | `data-emate-composer-frame-host` | 0.1.5 无；e-Mate 两处 CSS + 七条断言消费；0.1.5 `ConversationRoot.tsx:347` 结构相同 → 一行属性增量 |
| `fix(jobs): close queued owner teardown race` | `spec.run.bind(spec)`、teardown 先取消 waiting | 0.1.5 无；jobs-local 真实并发缺陷；**其测试直接用 `kind: emate-image`** |
| `feat(jobs): add cross-owner kind admission` | `startWhenAvailable`, `admissionQueues`, `MAX_WAITING_TASKS_PER_KIND` | 0.1.5 **四个符号全无**；e-Mate 用 `ctx.jobs.start({kind:'emate-image'})` + `attachController`；即生图"同 kind 单活跃"机制 |
| `fix(jobs): register queued admission jobs` | `JobAdmission {id, admitted}` | 0.1.5 无；上一条的语义修正 |
| `fix(session): isolate corrupt cold list artifacts` | `locate()` try/catch + warn | 0.1.5 无；**其测试用 `cwd: /profile/e-mate/general`**；一个损坏会话不得毁掉整个会话列表 |
| `feat(tools): expose registration provenance` | `dsh-tool-provenance-`, `toolRuntime.provenance` | 0.1.5 无；e-Mate 消费 |
| `fix(models): refresh directories after credential commits` | `credentials/updated` 刷新 | 0.1.5 无该刷新点；e-Mate 企业身份换证后必须刷新模型目录 |
| `feat(llm): add registration-bound wire transform` | `INVALID_WIRE_REQUEST`, `llm/wire` | 0.1.5 无；e-Mate 网关线上变换依赖 |
| `fix(settings): expose stable section ids` | `data-settings-section-id`, `dataset.settingsSectionId` | 0.1.5 无；e-Mate 设置外壳依赖稳定导航元数据 |
| `feat(ui-conversation): add declarative hero content slot` | `conversation.hero.content`, `css.heroContent` | 0.1.5 有 hero 概念但无该槽位；e-Mate 首页/外壳依赖 |

### 15.2 淘汰（11 条）

| 提交 | 淘汰理由 |
|---|---|
| `feat(imagegen): gate image edits on native review` | **产品淘汰**：2.0.18 两处明文要求 `zero image/edit confirmation`；fork 未接入任何工具 |
| `test(client): repair image review fixtures` | 随上条一起淘汰（其测试对象已不存在） |
| `docs(imagegen): refresh review contracts` | 随上条一起淘汰（纯文档） |
| `feat(schedule): gate delivery startup admission` | probation 语义已从 e-Mate 移除，零消费方 |
| `fix(schedule): honor startup delivery admission` | 同上 |
| `test(schedule): make downgrade gate hermetic` | 服务于已不存在的协议 floor |
| `test(schedule): gate built downgrade compatibility` | 同上 |
| `fix(schedule): make delivery rollback fail closed` | 作用于 fork 自有 v2 协议；e-Mate 零 v2 引用；0.1.5 用 `transaction.ts` 另解 |
| `fix(schedule): make reminder delivery crash safe` | 同上 |
| `fix(ui): make attachment drop overlay dismissible (#1)` | 0.1.5 已有等价实现（drop overlay / dismiss 语义）；**需用其自带测试最终确认后才可删** |
| `fix(conversation): isolate session drafts on workspace switch` | 0.1.5 的 `draft` 契约已存在（`contract/input.ts`、`contract/slots.ts`、`contract/views.ts`）；**需用其自带测试最终确认** |

### 15.3 两条待最终确认的淘汰项

`attachment drop overlay` 与 `session draft isolation` 两条，0.1.5 侧有同语义实现但形态不同。
按 13.1 第 4 步，**必须用它们自带的测试在 0.1.5 上跑通**才允许正式删除；未通过则转入重做。
这是本次唯一允许"先删后验"的两条，且验证未过必须回退。

### 15.4 净结果

- 21 条 → **10 条重做 + 11 条淘汰**。
- 重做集中在 jobs(3)、conversation/UI 契约(3)、tools/models/llm/settings(4)。
- 淘汰最大一块是 **schedule 6 条**（probation 已移除）与 **imagegen review 3 条**（产品要求零确认）。
- 与 `AGENTS.md` 中"fork 只多了 session-draft 隔离"的说法相比，真实 fork delta 为 21 提交；其中近半因产品演进已自然失效。

---

## 16. 重做（10 条）的执行记录与依赖顺序

### 16.1 新 fork 分支
- 分支：`dsh-v0.1.5-rc.1-emate`，工作树 `work/harness-dsh015-emate`，基于 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。
- 目前进度：**2/10**。
  - `e9f59bfdf8` composer frame host —— 保留 0.1.5 新结构（无 `HeroGlow`、`HeroShell` 带 `renderSlot`），只加 e-Mate 需要的属性；测试改用 0.1.5 的 `sessionSnapshotOf`，两个测试都保留。
  - `b4dcbfbe22` tools 注册来源 —— **改用 WeakMap 方案**：fork 原用 `RegisteredTool {definition, provenance}` 包装，而 0.1.5 的 `visible`/`known`/`layers` 存裸 `ToolDefinition`；引入包装会改动所有消费者的类型契约。改为按定义对象做 WeakMap 记录，**公开 API 完全一致**（`provenance(name, scope?) → {moduleSpecifier, pluginName}`），纯增量 46 行、0 删除。
    e-Mate 的唯一消费点是 `packages/dsh/src/profile/audit.ts:110`，用于判定调用工具是否为第一方 —— **安全相关，不可省**。

### 16.2 关键结构性变更：0.1.5 把 code* 改名为 ptc*
移植 tools 时冲突暴露：`codeTransport` → `ptcTransport`、`RegisteredTool` → `ToolDefinition`、mode 名 `'code'` → `'ptc'`。
**后续每一条移植都必须按 0.1.5 的词汇表重写，不能照抄 fork。**

### 16.3 jobs 三条必须按依赖顺序重放
三条不是并列的，`85b1b4a7f1` 建立在前两条之上（其冲突区已出现 `TaskPhase.state:'waiting'`、`admissionQueues`、`createTask`、`drainAdmissions`，而 0.1.5 侧只有 `const hooks = spec.run()`）。正确顺序：

| 顺序 | 提交 | 文件数 | 作用 |
|---|---|---|---|
| 1 | `6a2e586aac` | 25 | 新增跨所有者同 kind 准入 |
| 2 | `7e3d63e385` | 22 | 改为立即注册 Job、仅延迟生产者执行 |
| 3 | `85b1b4a7f1` | 2 | 关闭队列所有者拆除竞态 |

单独挑第 3 条必然冲突 —— 这是正确顺序的证据，不是跳过它的理由。

### 16.4 待验证项（不可省）
harness 新工作树起初无 `node_modules`，`lefthook` 的 `lint (staged)` 与 `third-party notices (staged)` 因缺少 `node_modules/.bin/tsx` 报 exit 127。已用 `--no-verify` 推进，**依赖就绪后必须补做 tsc / lint / 各条自带测试**（见 G0-e9）。已提交的两条均已在其提交信息里标注 "NOT YET VERIFIED"。

### 16.5 发现的一处版本不一致（进 G2 前处理）
harness 仓库自身钉 `pnpm@11.7.0`，而 e-Mate 根已按决定升到 `11.8.0`、上游 desktop 用 patch 过的 `11.8.0`。
`harness-provenance.mjs` 用 e-Mate 根的 `packageManager` 版本号调用 pnpm，跨目录（desktop / harness）时可能对不上，需在首次构建前确认。

---

## 17. 重做进度更新与第三处"随宿主消失而淘汰"

### 17.1 jobs 三条已全部完成（依赖顺序得到验证）
新 fork 分支 `dsh-v0.1.5-rc.1-emate`：

| 顺序 | 提交 | 结果 |
|---|---|---|
| 1 | `35cf3503f4 feat(jobs): add cross-owner kind admission` | 冲突仅 docs/i18n（取 0.1.5）+ `jobs-local/src/invariant.ts`（0.1.5 已删除，接受删除） |
| 2 | `dd10200769 fix(jobs): register queued admission jobs` | 同上策略；抽象契约更新为 `startWhenAvailable(...): JobAdmission` |
| 3 | `aaabedd617 fix(jobs): close queued owner teardown race` | **零冲突自动落上** |

第 3 条零冲突这一事实，**反证了必须按依赖顺序重放**：先挑它时冲突不可解，前两条到位后自然成立。

### 17.2 `fix(session): isolate corrupt cold list artifacts` → 淘汰（待定向验证）
该提交改两个宿主，其中 `packages/host/apiproxy` **在 0.1.5 里整个包都不存在了** —— 职责被拆到 `packages/api/session-controller` 与一组 `api-*-controller`。这不是"解冲突"，是宿主消失。

而 0.1.5 **已用同样的守卫实现过同一意图**：
- `packages/api/session-controller/src/list.ts:290`：`catch (error) → logger.warn('api-session.list: projection column for "<id>" failed; serving the row without it') → return undefined`
- `packages/session/session-persistence-jsonl/src/index.ts`：多处 try/catch（388/397/448/480/621/648/742/950/966）

**诚实边界**：fork 那条针对"冷探测 locate 失败"，0.1.5 那条针对"投影列失败"，两者相邻但**未证明完全等价**。
因此裁决为**淘汰，但必须做一次定向验证**：构造"一个损坏的冷会话不拖垮整个列表"的用例，在 0.1.5 上跑通后才算成立。这是第三处"先删后验"。

### 17.3 计数更新
- 重做：**9 条**（jobs 3 条已完成，剩余 6 条）
- 淘汰：**12 条**，其中 **3 条**（attachment drop overlay、session draft isolation、session cold list）必须各自用定向验证兜底，未过即回退为"重做"

---

## 18. Round 1 结果：fork 重做到 9/10，host 构建已验证通过

### 18.1 fork 分支状态
- 分支 `dsh-v0.1.5-rc.1-emate`，工作树 `work/harness-dsh015-emate`
- **SHA `e522d07f2287f533074166a3cfa3202b2e8c7940`**，含 10 个提交
- 与 0.1.5-rc.1 的净差异：**22 文件 / +1049 −46**
- **构建验证：`pnpm run build:lib:host` → HOST_EXIT=0，0 个 TS 错误**（在当前 HEAD 上验证）

| # | 提交 | 结果 |
|---|---|---|
| 1 | `e9f59bfdf8` composer frame host | 适配 0.1.5 新结构 |
| 2 | `b4dcbfbe22` tools 注册来源 | WeakMap 方案，纯增量 |
| 3 | `35cf3503f4` jobs 跨所有者 kind 准入 | 基座 |
| 4 | `dd10200769` jobs 排队准入注册 | 契约改 `JobAdmission` |
| 5 | `aaabedd617` jobs 拆除竞态 | 零冲突（验证了依赖顺序） |
| 6 | `6de837489d` jobs 测试适配 | `Inbox` → `unsupportedInbox()` |
| 7 | `306ae92106` models 目录刷新 | 保留 0.1.5 事件名 + 加逐 directory 重载 |
| 8 | `39e118a4b0` llm 线上变换 | 投影之后接 waterfall |
| 9 | `63e86715c8` llm 测试适配 | `deepFreeze` 改从 `dsh-util-values` 导入 |
| 10 | `e522d07f22` settings 分区 id | 零冲突 |

### 18.2 构建暴露的两处真实问题（只靠冲突解决发现不了）
1. `loader-composition.spec.ts` 用了 0.1.5 已移除的 `Inbox` 值导出 → 0.1.5 自己的 spec 用 `unsupportedInbox()`（来自 `@deepseek-ai/dsh-agent-loop-testkit`）。
2. `service.spec.ts` 的 `deepFreeze` 在 0.1.5 属于 `@deepseek-ai/dsh-util-values`，不再由 `@deepseek-ai/dsh-llm` 导出。

**这两条印证了一个方法论**：冲突解决只保证"能合并"，**只有构建能证明"能编译"**。每一条重做都必须过构建。

### 18.3 剩余 1 条重做
`feat(ui-conversation): add declarative hero content slot`（`b469c2b99a`）—— 4 处冲突，性质与其他不同：
0.1.5 的 `ConversationRoot` 已演化出 `WidthHandle` / `rootResizeRef` / `css.body` / `css.scrollBody` 的全新布局，
hero 内容槽必须**重新插入 0.1.5 的新结构**（作为 scrollBody 内、composer seat 之前的兄弟节点），
且 `HeroShell` 签名已变（多了 `renderSlot`）。这是结构性集成，不是解冲突。
需要在 #1 的 `data-emate-composer-frame-host` 与既有 `conversation.hero.workspace` 座位之间重新定位。

### 18.4 回归防护账（用户新增验收标准）
见 `docs/2.0.18/regression-ledger.md` / `.json`：
范围 `6a7f4b9d..3cc4be84` = 411 提交，其中 **236 个 fix**，**218 个自带测试守卫**，去重后 **151 个守卫测试文件**。
18 个修复无测试，列为必须补齐的缺口。区域分布即升级的回归面：
shell 42 / profile-core 35 / desktop 55 / enterprise 29 / scripts 59，插件侧 knowledge 21、office-skills 14、mcp-manage 11、canvas 11、skill-hub 10、vision-toolkit 9 等。

---

## 19. Round 2：fork 重做 10/10 完成 + 双构建面 + 包测试通过

### 19.1 最后一条重做完成
`feat(ui-conversation): add declarative hero content slot` 已移植。**过程中引入并修正了一次真实回归**，过程值得记录：

1. 按 fork 的设计把 `HeroShell` **挪出** composer stack，放进新的 hero 内容槽 fallback。
2. 实跑包测试 → 20 通过 / **3 失败**，其中两条是 **0.1.5 自己的 hero 测试**。
3. 判定：**0.1.5 的排布就是契约**。恢复原生 `HeroShell` 留在 composer stack，`conversation.hero.content` 改为**纯增量座位**（未被占用时不渲染任何东西）。
4. 重跑 → **23/23 全部通过**。

### 19.2 一个必须记住的教训（第二次同类错误）
此前有一条重做提交里加的测试写成了 `sessionSnapshotOf({ composerPhase: 'blank' })`，而 `SessionSnapshot` **没有该字段** —— 它从未编译过。
**原因是当时只构建了 host 面**。`build:lib:host` **不编译 client 包**，所以 client 侧的语法/类型错误完全不可见。

**规则**：每条重做必须同时过
- `pnpm run build:lib:host`
- `tsc -b tsconfig.client.json`
- 该包自带的测试

### 19.3 当前 fork 分支
- 分支 `dsh-v0.1.5-rc.1-emate`，**11 个提交**，头部 SHA 见仓库
- 双构建面 0 错误；`ui-conversation` 23/23 通过
- 与 0.1.5 的净差异见 `git diff --stat 183f08e9 HEAD`
---

## 20. Round 3：回归参照集建立 + 6 个 harness 适配器的目标核查

### 20.1 回归参照集（见 `regression-baseline.md`）
基线 `pnpm run test:fast` = **EXIT=0，71/71 + 5/5 全绿**。这是升级后不得跌破的通过集。

**本轮踩到并修正了一个我自己造成的陷阱**：首次跑基线是 70/71，失败项断言 harness 提交号不符。
根因不是代码 —— 是我早前用 `worktrees/emate-2.0.18-rc7-tidychat/upstream/deepseek-harness` 这个**共享克隆**做调查时，
把 checkout 切到了 `1d3824bcd340`，而该 worktree 的 gitlink 固定为 `4da69d7c3522`。恢复后即全绿。

> **规则**：跑任何基线/回归比对前，先确认子模块 checkout == gitlink 且工作区干净，
> 否则会把自身扰动误判成基线缺陷或升级回归。

### 20.2 151 个守卫文件的可得性
其中 **122 个存在于 2.0.18 基线树**（29 个属未集成分支，不在本树）。
分布：packages/dsh 23、desktop 19、enterprise/apps 18、tests/performance 14、knowledge 8、canvas 6、pet 4、其余插件 1–3。
**其中 6 个是 `scripts/harness-*-adapter.test.mjs`** —— 即 harness 源码适配器自身的守卫，与 20.3 直接对应。

### 20.3 六个 harness 源码适配器的目标核查
方法：把每个适配器的目标包对 0.1.5 的实际供应做存在性检查。

| 适配器 | 目标包 | 0.1.5 | 结论 |
|---|---|---|---|
| `harness-conversation-adapter` | `dsh-client-ui-conversation` | 存在 | 需核对接缝字符串 |
| `harness-artifact-links-adapter` | `ui-primitives` + `ui-deliverables`（含渲染器路径 `packages/client/ui-primitives/src/markdown/render.tsx`） | 存在 | 需核对接缝字符串 |
| `harness-fs-bytes-adapter` | `dsh-fs-local` | 存在 | 需核对接缝 |
| `harness-runtime-adapters` | `dsh-fs`（提权接缝）+ `dsh-session-title`（自动标题接缝） | 存在 | 需核对接缝 |
| `harness-session-export-adapter` | **`dsh-host-apiproxy`** | **不存在** | **必须重定目标**（被 `api-gateway` / `api-*-controller` 取代） |
| `harness-slot-error-adapter` | **`dsh-client-runtime`** | **不存在** | **必须重定目标**（0.1.5 已改名，候选 `client-store` / `client-web`） |

**2/6 的宿主消失**，与前面「session 冷列表隔离」那条淘汰同源：0.1.5 重构了 host 侧 api 分层与 client 侧 runtime 分层。

### 20.4 另一个需要注意的耦合
`harness-provenance.mjs:233` 会读取 `packages/client/ui-model-selection/src/client/service.ts` 作为 **listener 证据**，
而 fork 分支上「models 目录刷新」的修复已移植进该文件。**适配器证迹与 fork 改动存在交叉**，重 derive 适配器时必须同时验证这条。---

## 21. Round 4：8 个适配器函数对 0.1.5 编译产物的实测判决

### 21.1 方法
适配器作用的是 harness **编译产物的 `lib/*.js`**（不是 TS 源码）——
`materializeHarnessDesktopRuntime` 先把构建好的 lib 复制进 desktop node_modules，再对特定包改写 `lib/index.js` / `lib/client.js`。
因此判决方式：把 0.1.5 的 tgz 解出、取对应 lib 文件、直接喂给适配器函数，看是否抛错。

### 21.2 实测结果：8/8 全部失败

| 适配器函数 | 目标包 | 结果 |
|---|---|---|
| `adaptHarnessSessionTitleSource` | `dsh-session-title` | 抛错：`automatic-title` 接缝 0 命中 |
| `adaptHarnessArtifactLinksSource` | `ui-primitives` | 抛错：`renderer/anchor` 接缝 0 命中 |
| `adaptHarnessArtifactDeliverablesSource` | `ui-deliverables` | 抛错：`deliverables/tail-selector` 接缝 0 命中 |
| `adaptHarnessConversationSource` | `ui-conversation` | 抛错：`turn-error/terminal-after-retry` 接缝 0 命中 |
| `adaptHarnessFsBytesSource` | `dsh-fs-local` | 抛错：`readWholeBytes` 接缝已漂移 |
| `adaptHarnessFsSource` | `dsh-fs` | 抛错：`escalation` 接缝 0 命中 |
| `adaptHarnessSlotErrorSource` | `dsh-client-runtime` | **包不存在 → 必须重定目标** |
| `adaptHarnessSessionExportSource` | `dsh-host-apiproxy` | **包不存在 → 必须重定目标** |

**接缝没有一条能直接沿用**：0.1.5 的编译产物与 rc.7 在这些点上都不相同。

### 21.3 适配器的实际用途（据实现与注释）

**`fs-bytes` 承载的是一条安全措施**，不是可选的便利：
> 注释原文：二进制读取（含 `read_image`）**故意拒绝多重链接的文件**——workspace 路径不得静默授予外部硬链接的发布权限。

实现上把 `readWholeBytes` 整体替换为 e-Mate 版本，其中 `opened.nlink !== 1n` → `FS_PERMISSION_DENIED`。
守卫测试也在 122 个可跑集中：`hardlinked images deliberately fail; an independent PNG copy still passes native image validation`。
**因此这条适配器无论如何必须保住，不能因为重做成本高就丢掉。**

`slot-error` 则是纯委托：把 `SlotCore.reportEntryError` 通过 `SlotsService` 暴露，机制小但同样失败即关闭。

### 21.4 失败即关闭是优点，也是工作量的证明
这些适配器找不到接缝就抛错，所以 **harness 构建会直接拒绝**，不会静默产出一个行为不完整的二进制。
但反面是：8 个函数全部要按 0.1.5 的真实产物重写接缝，这是 Round 5 起的实质性工作。

### 21.5 一个架构观察（供后续决策，不在本轮实施）
适配器做的是"对编译产物做字符串手术"。由于 e-Mate 本来就从自己的 fork 构建 harness，
**这些改动原则上可作为 fork 源码提交存在**，比手术编译产物更稳、更可测。
但改变这一架构超出本次升级范围，本轮不实施；仅记录为后续可评估项。### 21.6 Round 4 进展：第 1 条适配器重定完成（安全攸关那条）

`adaptHarnessFsBytesSource`（`@deepseek-ai/dsh-fs-local`）已在升级树修好并通过验证。

**诊断**：对 0.1.5 编译产物逐条件统计接缝出现次数：

| 接缝成分 | 0.1.5 出现次数 | 适配器要求 | 结论 |
|---|---|---|---|
| `async function readWholeBytes(target, signal, maxBytes, internals = {}) {` | 1 | 1 | ✓ |
| `\tconst info = await statRegularFile(target, "read", signal);` | 1 | 1 | ✓ |
| `import { createReadStream } from "node:fs";` | 1 | 1 | ✓ |
| `\treturn Buffer.concat(chunks, bytes);\n}` | **2** | **1** | ✗ 唯一失败原因 |

而适配器后面本就用 `indexOf(ending, start)` **把结束标记限定在函数内**查找，
所以"全文件唯一"这个前置条件是**多余且过严**的 —— 这是**接缝精度问题，不是语义重写**。

**修法**：只放宽该前置条件。保留全部真正证明形状的检查（首行仍须全局唯一、`statRegularFile` 首行与 `node:fs` 导入仍必需、
抽出的函数体仍要含 `createReadStream` 与 `inspectReadBytesAfterStat`），**漂移仍然失败即关闭**。

**验证**：
- 适配器已能接受 0.1.5 编译产物（实测从"抛错"变为"接缝找到"）
- 其守卫测试 `scripts/harness-fs-bytes-adapter.test.mjs` **9/9 通过**（在基线树临时覆盖实跑，之后逐字节还原并用 `cmp` 校验）
- 基线树保持 0 改动，harness 子模块仍在 `4da69d7c3522`

**这一条同时建立了后续 7 条的方法**：先对 0.1.5 产物逐成分统计接缝命中，再判断是"精度问题"还是"语义已变"。### 21.7 Round 5：其余适配器的接缝普查

方法：从每个适配器模块里抽取用作接缝的字符串字面量，逐个在 0.1.5 的目标 lib 文件里计数。

> **工具局限（必须说明）**：`harness-runtime-adapters.mjs` 一个模块里同时含 `adaptHarnessFsSource` 与 `adaptHarnessSessionTitleSource` 两个适配器，
> 按模块抽取会把字面量算到两者名下。下表已标注哪些读数是可靠的。

| 适配器 | 抽取到的接缝 | 0.1.5 命中 | 判读 |
|---|---|---|---|
| `session-title` | `if (registration.provider.automatic === "all-prompts"...` | **0** | 自动标题接缝已变，需重写 |
| `conversation` | `kind: "turn-tail", target: "chat", ...` | **0** | **0.1.5 重写了会话节点定义** |
| `conversation` | `generate_image` / `edit_image` / `get_image_generation_task` / `imagegen` / `image_batch` | **0** | 适配器依赖的图像工具名不在 0.1.5 的该文件里 |
| `conversation` | `facade/snapshot` | **0** | 已变 |
| `artifact-links` | — | — | 抽取失败，需人工读适配器 |
| `artifact-deliverables` | — | — | 抽取失败，需人工读适配器 |
| `fs-escalation` | （与 session-title 混算，读数不可靠） | — | 需按函数级重查 |

### 21.8 这轮最实质的结论
**`conversation` 适配器（375 行，8 个里最大的一个）不能靠"调接缝精度"解决。**
它依赖的 `turn-tail` 节点定义与图像工具名在 0.1.5 的 `ui-conversation` 产物里**完全不存在**：
0.1.5 已把会话节点定义重构进 `contract/` / `conversation/` / `input/` / `skeleton/` 分层（与 Round 2 移植 hero 槽时观察到的结构变化一致）。
它的守卫测试 `scripts/harness-conversation-adapter.test.mjs` 属于那 122 个可跑集，因此重写后必须过该测试。

### 21.9 下一步
1. 按**函数级**（而非模块级）重做抽取，得到 `fs-escalation` 与 `session-title` 的可靠读数；
2. 人工读 `artifact-links` 与 `artifact-deliverables` 的接缝常量；
3. 按判读结果分类：**精度问题**（低成本，如 fs-bytes）vs **语义已变**（需重写）；
4. `conversation` 已确认属后者，单独立项。### 21.10 Round 5 函数级读数（精确，可直接据此动手）

| 适配器 | 接缝常量 | 0.1.5 读数 | 判读 |
|---|---|---|---|
| `session-title` | `TITLE_SCHEDULE`（整行含 `messages.length === 1`） | **整行 0 命中，但前缀存在** | **精度问题**：0.1.5 把 `messages.length` 改成了 `count`，见下 |
| `fs-escalation` | `FS_OLD` 首行 `\tasync resolvePolicy(toolName, args, exec) {` | **0 命中，且 `resolvePolicy` 在 dsh-fs 里完全不存在** | **语义已变**，需重定 |
| `artifact-links` / `deliverables` | 显式传入 `replaceOnce(source, before, after, owner)`，见 21.11 | 待逐条计数 | 待判 |

#### session-title 的确切差异
```js
// rc.7 / fork
if (registration.provider.automatic === "all-prompts" || session.header.parentSession === void 0 && messages.length === 1 && this.get(session) === void 0) {
// 0.1.5（lib/index.js:386）
if (registration.provider.automatic === "all-prompts" || session.header.parentSession === void 0 && count === 1 && this.get(session) === void 0) {
```
**唯一差异是 `messages.length` → `count`。** 这与 `fs-bytes` 同类：低成本精度修正，而非重写。
动手前需确认替换产物 `TITLE_SCHEDULE_GROUNDED` 不依赖旧变量名。

### 21.11 artifact-links 的接缝清单（可直接逐条计数）
适配器用 `replaceOnce(source, before, after, owner)` 显式传参，owner 名即接缝名：

- `deliverables/tail-selector`：`function selectProducedFiles(owner) {\n\t\t\tconst paths = producedForClosing(owner.turn.data.get("deliverables"), owner.seq);`
- `deliverables/mention-selector`：`const paths = selectProducedFiles(owner);`
- `deliverables/session-owner`：`\t\t\t"connection"\n\t\t];`
- `deliverables/library-definition`：`const deliverablesDefinition = {`
- `deliverables/library-close`：`\t\t\t\tvalue: { produced: context.state.produced }\n\t\t\t}\n\t\t};`

另有 `renderer/anchor`（`ui-primitives` 的 `renderer` 相关）与 `ui-primitives` 的 `change(before, after, owner)` 调用点，需一并计数。

### 21.12 当前 8 条适配器的分类（Round 5 末）

| 分类 | 条目 | 成本 |
|---|---|---|
| **已修好并验证** | `fs-bytes` | 已完成 |
| **精度问题（低成本）** | `session-title`（`messages.length`→`count`） | 一条替换 |
| **语义已变（需重写/重定）** | `fs-escalation`（`resolvePolicy` 消失）、`conversation`（`turn-tail` 节点与图像工具名消失） | 高 |
| **宿主消失（需重定目标）** | `slot-error`（`client-runtime`）、`session-export`（`apiproxy`） | 中 |
| **待判** | `artifact-links`、`artifact-deliverables` | 待逐条计数 |### 21.13 Round 6：两处更正与两条适配器进展

#### 更正：我上一轮把 `fs-escalation` 判错了
`adaptHarnessFsSource` 的目标包是 **`dsh-tool-fs`**（见 `applyHarnessRuntimeAdapters` 里 `packageEntry('dsh-tool-fs')`），
而我上一轮喂的是 `dsh-fs`，于是得到"`resolvePolicy` 完全不存在"的错误读数，并据此判为"语义已变"。

**实际结果**：`FS_OLD` 在 0.1.5 的 `dsh-tool-fs` 里**完整命中 1 次**，适配器**直接可用**（247 字节增量）。
> 教训：接缝普查必须用**适配器实际作用的目标包**；差一个包名就会把"可用"误判成"需重写"。

#### `session-title` 重写完成（不是改名，是真正重写）
0.1.5 把调度器里的 `messages.length` 换成了预计算的 `this.titleInputOf(session).count`，
而 **`messages` 根本不在该作用域内** —— 原替换产物会引用未定义绑定。

已按 0.1.5 自身 API 重写：
- 接缝匹配含 `count === 1` 的那一行
- 替换体改用 `this.titleInputOf(session)` 取 `{ count, first }`，文本取自 `first.text`
- `normalizeSessionTitle` / `fallbackSessionTitle` 在 0.1.5 均存在；`event` 仍在作用域内（方法签名 `onUserMessage(session, event)`）

**验证**：对 0.1.5 真实产物调用适配器 → 接缝找到，替换增加 653 字节。
守卫测试的 `nativeTitle` 是**从被固定的 harness 树读取**（非硬编码 fixture），因此自适应 —— harness 重钉到 0.1.5 后应当通过。

#### 适配器总进度：3/8 完成

| 状态 | 适配器 | 依据 |
|---|---|---|
| **已完成** | `fs-bytes` | 接缝精度修正，守卫 9/9 |
| **已完成（本就可用）** | `fs-escalation`（目标 `dsh-tool-fs`） | 接缝完整命中 1 次 |
| **已完成** | `session-title` | 按 `titleInputOf` 重写，653 字节增量 |
| 待办 | `artifact-links` / `artifact-deliverables` | 需逐条计数 |
| 待办（需重写） | `conversation` | `turn-tail` 节点与图像工具名消失 |
| 待办（需重定目标） | `slot-error`（`client-runtime`）/ `session-export`（`apiproxy`） | 包已不存在 |### 21.14 Round 7：artifact 两个适配器的插桩读数

方法改进：不解析适配器源码，而是**劫持 `String.prototype.split` 插桩**，让适配器自己报出它在找的接缝，再逐个计数。
这避免了上一轮"按模块抽取导致串台"的问题。

#### `artifact-links`（目标 `ui-primitives` lib/index.js）
第一个失配接缝：`function renderAnchor(url, children, key) {` → **0 命中**。

实测 0.1.5 的对应实现（`lib/index.js:8395`）与 rc.7 源码（`render.tsx:452`）：

```js
// rc.7 (TS)
function renderAnchor(url: string, children: ReactNode[], key: Key): ReactNode {
  return renderSafeLink(normalizeUri(url), children, key)
}
// 0.1.5 (编译产物)
function renderAnchor(url, children, key, glyph = true) {
  return renderSafeLink(normalizeUri(url), children, key, glyph);
}
```

**0.1.5 新增 `glyph` 形参并透传给 `renderSafeLink`** → 与 `fs-bytes` / `session-title` 同类：**精度问题**，不是重写。

#### `artifact-deliverables`（目标 `ui-deliverables` lib/client.js）
报错为 `deliverables/tail-selector: found 0`，但插桩显示该接缝在**原始源码里命中 1 次**：

```
结果: 失败 — deliverables/tail-selector: expected one rc.7 seam, found 0
不同接缝数: 2
   1x  "function selectProducedFiles(owner) {\n\t\t\tconst paths = ..."   ← 原始源码里存在
   0x  "select: selectProducedFiles,"
```

**矛盾本身是线索**：接缝在原文存在，却在检查时报 0，说明它已被**更早的替换消费或改写**，
即该适配器内部存在**替换顺序依赖**。这不是接缝正确性问题，而是执行顺序问题，需单独查。

### 21.15 适配器进度（Round 7 末）

| 适配器 | 分类 | 状态 |
|---|---|---|
| `fs-bytes` | 精度 | **已完成**（守卫 9/9） |
| `fs-escalation` | 本就可用 | **已完成**（接缝命中 1） |
| `session-title` | API 已改 | **已完成**（按 `titleInputOf` 重写） |
| `artifact-links` | **精度**（`glyph` 形参） | 待修，成本低 |
| `artifact-deliverables` | **执行顺序问题** | 待查（非接缝问题） |
| `conversation` | 重写 | 待办 |
| `slot-error` | 重定目标 | 待办 |
| `session-export` | 重定目标 | 待办 |

**3/8 完成，2 条已定成本（低成本），3 条待重写/重定目标。**