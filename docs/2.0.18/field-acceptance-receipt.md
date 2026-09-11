# 2.0.18 实机验收回执（本机 macOS）

方法与判定口径见 `docs/2.0.18/field-acceptance-plan.md`。本文件只记录**实际执行**的用例与结果。
判据只允许 `PASS / FAIL / BLOCKED / NEEDS_EVIDENCE / OPEN / OUT_OF_SCOPE`。

## 0. 候选身份

| # | 平台 | 源码 HEAD | DMG 字节 | DMG sha256 | 状态 |
|---|---|---|---|---|---|
| C1 | macOS | `a10b485f06` | 466413297 | `65cef6f47e6a5d1c03146472cd75c85c4288d170cf953a47d905646232e6c98b` | **已作废**（见 AC-01） |
| C2 | macOS | `5bed0f831b` | 466413246 | `6234906b786570c1f1d5dcc158c4cb7eca09596fdb9152c6141cb10544774a14` | **已作废**（AC-01 修复载体；AC-02 缺陷在其上暴露） |
| **C2b** | macOS | `a215988139` | 466417923 | `d5254bd60f778709f2dee0cf42d542a847fe25007aeac4d5c3b7c135302c2b59` | **待验收（当前安装态）** |
| **C4** | Windows | `a215988139` | 335410291 | `67797411e7043bbc467e4099fc091f0966d5d4ab213fe4a15122112f17788bc4` | **待验收（未安装）** |

C2b/C4 同源：父仓 HEAD = `a215988139`（已推送），Harness gitlink = 子模块 HEAD = `e217fb0c8d8e377be6d9c0514446f9455821a79b`。
| C3 | Windows | `a10b485f06` | 构建中 | 构建中 | 将被 C4 取代 |
| C4 | Windows | `5bed0f831b` | 未开始 | 未开始 | 待构建 |

C1 的来源链（当时实测一致）：父仓远端 = 本地 HEAD = gitlink = 子模块 HEAD = fork 远端 = `a10b485f06` / `43c411a51c…`；
构建自带两级冒烟通过（packaged node-pty smoke、macOS DMG smoke 挂载→校验 Info.plist→卸载）；
未签名（`Signature=adhoc`，`TeamIdentifier=not set`），符合"未签名分发"口径。

安装后的可执行文件与 DMG 内完全一致：
`Contents/MacOS/e-Mate` sha256 = `a4692c33e58b0afa46917e8dbb530fb8f909cf8eaa20abf639e0d48a91c3ccde`（66736 字节，`x86_64 arm64`）。
候选内含组件仓库 **19 行**（含 `@e-mate/dsh-plugin-turn-fold`）与 `bundles/turn-fold`。

## AC-01 升级安装后启动即退出 —— **FAIL**（C1，已修，需在 C2 复测）

**操作**：`rm -rf /Applications/e-Mate.app` → `ditto` 从 DMG 拷入 → `open -a`。
**现象**：进程约 12 秒后消失；AX 观测只剩菜单栏，**没有任何窗口**；默认端口 3080 无监听。

**证据（直接运行 `Contents/MacOS/e-Mate` 捕获的输出）**：

```
@e-mate/desktop: Error: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry emate-tidychat (@e-mate/dsh-plugin-tidychat):
Cannot find module '.../home/profiles/e-mate/node_modules/@e-mate/dsh-plugin-tidychat/lib/index.js'
```

**根因**（实测，不是推断）：`@e-mate/dsh-plugin-tidychat` **已被 2.0.18 退役**
（组件清单里没有、组件仓库里没有、App 里没有，`scripts/no-core-rewrite-guard.test.mjs:49-52` 还断言该包被删除），
但它**从来没有被加进两个安装器的 `RETIRED_PROFILE_PACKAGES`**。于是升级安装保留了：

- 旧 profile 的 `package.json` 里 `dsh.profile.bundles` 仍列着它（实测 `package.json:32`）；
- `node_modules/@e-mate/dsh-plugin-tidychat/lib` 是一个**指向旧 App 包内路径的符号链接**——
  而那个旧 App 已经被本次原地替换删掉，链接悬空。

结果：加载器跟着一个悬空的 bundle 走进了被替换掉的应用程序，启动即失败。

**为什么本地门禁抓不到**：所有本地门禁都从**全新** profile 装配，`RETIRED_PROFILE_PACKAGES` 的
删除路径只在"已有旧 profile 再升级"时才会被执行到——这正是实机验收存在的意义。

**修复**：`5bed0f831b` —— 两个安装器各自把 `@e-mate/dsh-plugin-tidychat` 加入
`RETIRED_PROFILE_PACKAGES`；两个 profile 修复测试各增加一条"种入陈旧 tidychat 安装 → 断言下次安装
删目录、删依赖、删 bundle 条目"的守卫（与 computer-use 同一形状）。
本地实测：`test:fast` EXIT 0（68/68 + 38/38），desktop profile 套件 17 passed。

**复测要求**：C2 必须**保留当前这套被弄坏的 profile**再安装一次，验证 App 能自愈并正常启动；
这条用例在 C2 上重跑前保持 `OPEN`。

## AC-02 安装态「无法加载插件」、界面完全不渲染 —— **FAIL（C2）→ 源码已修（`a215988139`），待 C2b 复测**

**操作**：C2 安装完成后 `open -a e-Mate`（profile 已自愈为 2.0.18）。
**现象**：模态告警 「e-Mate could not load all plugins.」——
`Failed plugins: - @deepseek-ai/dsh-client-ui-sidebar - @e-mate/dsh-plugin-find-skill`，
`The client Loader did not provide an error message.`；主窗口只有该告警，**没有任何产品界面**。

**实机取证**（`ELECTRON_ENABLE_LOGGING=1` 直接运行 `Contents/MacOS/e-Mate` 捕获渲染进程 console）：

```
Error: failed to import loader entry 41292524 (dsh-file-viewer): client-modules: require(
"@deepseek-ai/dsh-client-runtime/client") missed the module table — not a platform seed word,
not a materialized module, and no registered package factory
```

**根因（两条，互为遮蔽）**：

1. **`conversationEvents` 是 rc.6 的客户端服务名。** 0.1.5-rc.1 把会话节点注册表搬到
   `uiConversation.events`（`packages/client/ui-conversation`）；本仓已迁移的贡献者
   （univer-office、ui-chat、ui-trajectory）全都用新拼写。e-Mate shell 与
   `@e-mate/dsh-plugin-find-skill` 仍 inject 旧名，而 Cordis 对无法满足的 inject 永久保持
   PENDING —— 两者都不激活，渲染进程的健康检查（`src/client/boot-health.ts`，判据是
   fiber state ≠ ACTIVE）于是把它们报成"加载失败"。全 profile 里只有这两个插件声明该服务名，
   与告警列出的两个名字**完全对应**。
   同一类漂移还包括两个 vendored 生态包：`dsh-file-viewer` / `dsh-at-file` 的 client bundle
   在模块初始化处 `require("@deepseek-ai/dsh-client-runtime/client")`，而 0.1.5 没有这个包
   （两者只用到 `defineStore` / `createSnapshotStore`，都已是 0.1.5 平台 seed 词
   `@deepseek-ai/dsh-client-store` 的导出）。

2. **槽重复声明。** inject 修好后 shell 才第一次真正 apply，随即暴露第二层缺陷：Gallery 视图把
   `conversation.message.images` 重新声明为 `conversation.view` 座位的子槽，而 pinned
   `ui-chat` 条目（`packages/client/ui-chat/src/client/apply.ts:105`）已经声明过它；
   ui-slots 拒绝第二次声明（`slot "…" is already declared`）并中止整个 shell apply。

**为什么所有既有门禁都抓不到**：`test:fast`、`component-run check`、profile boot smoke 都只验证
"bundle 被装配、被服务、能注册"——没有一个**真正执行 bundle 工厂并激活 Cordis 客户端插件**；
`packages/dsh/test/client-inject-edges.test.mjs` 只按"**包**是否存在"判定客户端边，而服务是包里的
一个**名字**。这正是"升级安装后"才会暴露的那一类缺陷。

**修复（`a215988139`，子模块 `e217fb0c`，均已推送）**：
1. shell 与 find-skill 的 4+1 处注册改走 `ctx.uiConversation.events`，inject 名改 `uiConversation`；
2. Gallery 不再重复声明 `conversation.message.images`；
3. 两个 vendored 生态包的 yarn patch 把退役 specifier 改指 `@deepseek-ai/dsh-client-store`；
4. find-skill 子模块的客户端依赖由 rc.6 升到 0.1.5-rc.1（类型面：cordis / ui-conversation / ui-chat / ui-renderer）；
5. 新守卫：`client-inject-edges.test.mjs` 拒绝任何已交付客户端贡献 inject 已退役的客户端服务名；
   find-skill 契约测试与 shell 契约断言改为 0.1.5 拼写。

**实机因果验证（诊断式，不构成候选验收）**：把 1–3 三处改动**按位**施加到已安装 C2 的 profile
bundle 上再重启 App —— 模态告警消失，主窗口渲染出完整产品界面（登录页：`欢迎回来` /
`全场景办公 AI Agent` / 右上 `2.0.18 · 11,000 PTS · 已整合`）。
截图留档（按 AGENTS.md，验收截图不入库）：`~/.dsh-computer-use/artifacts/session-27e2cf42-7243-4aad-a60b-4065c4b0d9ef/observation-27f11cb9-12bf-427f-8fcb-6cf774c6d536.png`。

**复测要求**：必须用**重新构建**的候选（C2b）复现同一现象已消失 —— 手工改 profile 只证明因果，
不构成候选或安装态验收。在 C2b 上重跑之前，本条保持 `OPEN`。

## AC-02 复测（C2b）—— **PASS**

**候选字节**：DMG `e-Mate-2.0.18-mac-universal.dmg` 466417923 字节 / sha256 `d5254bd6…`；
`hdiutil attach` → `ditto` 覆盖安装到 `/Applications/e-Mate.app` 后，
安装态与 DMG 内 App 的 `Contents/Resources/app.asar` sha256 完全一致
（`3a551840fa7d77be8ec97f52be6f82df856e2f56fee1a9e4af0b93ae6ed458b4`）。

**候选内证据**（`app.asar.unpacked/build/e-mate-profile`）：
- `plugins/emate-shell/lib/client.js` 481571 字节：`conversationEvents` 0 处、`uiConversation.events.register` 4 处；
- `bundles/find-skill/lib/client.js`：`conversationEvents` 0 处、`uiConversation` 2 处；
- `ecosystem/dsh-file-viewer/lib/client.js` 与 `ecosystem/dsh-at-file/lib/client.js`：
  退役 specifier 0 处、`@deepseek-ai/dsh-client-store` 各 1 处；
- `bundles/turn-fold/` 存在。

**实机证据**：`open -a e-Mate` → 3 个进程、`127.0.0.1:3080` LISTEN；
**没有**任何 "could not load all plugins" 告警或失败页；主窗口 1280×787 渲染出完整产品界面
（页头 `e-Mate | AI OFFICE AGENT`、右上 `2.0.18 · 11,000 PTS`、登录卡 `欢迎回来`/
`账号或邮箱`/`密码`/`保持登录`/`登录`/`注册新账号`、主视觉 `全场景办公 AI Agent`）。
渲染进程 console（`ELECTRON_ENABLE_LOGGING=1` 直接运行二进制捕获）只剩一条既有良性提示
`[genui] fence-registry 扩展点不存在（原版 DSH）——启用 DOM 渲染通道`，
**没有** `failed to import loader entry`。
截图留档（按 AGENTS.md 不入库）：
`~/.dsh-computer-use/artifacts/session-27e2cf42-7243-4aad-a60b-4065c4b0d9ef/observation-04b5df1a-4483-4a38-9e4b-14e4c04588a6.png`。

## AC-03 AC-01 复测（C2b，升级安装路径）—— **PASS**

保留上一版被改动的 profile（含手工诊断补丁）直接覆盖安装 C2b：App 启动成功，
profile 依 `.e-mate-install.json`（schema 2 / 2.0.18 / harness `43c411a5`）自愈，
无 tidychat 残留，无悬空 bundle。C2 上测得的启动即退出在 C2b 上不再出现。

## 性能：生图延迟（对照 = DSH 原版，同渠道同提示词）—— **部分完成**

| 侧 | 渠道/模型 | 提示词 | 样本 | 结果 |
|---|---|---|---|---|
| 对照：DSH 原版（本机 127.0.0.1:3180 会话） | `openai` / `gpt-image-2.5-flare` | 固定测试卡提示词 | 3 | 19650 / 17938 / 19330 ms，全部 completed，中位数 **19330 ms** |
| 处理：e-Mate C2b | 同一渠道（插件配置相同） | 同一提示词 | 待测（需登录） | `OPEN` |

首响与多轮延迟：`OPEN`（需登录后实测；对照侧需以企业模型同条件运行，方法见 plan §4）。

## 其余用例

| 组 | 状态（C2b） |
|---|---|
| A 登录与企业 | **`PASS`**（登录与企业鉴权面）：企业主机可达（`https://mvdcm.ecoremedia.net` → HTTP **302**，0.63 s；先前 `http=000` 测的是 txt 里的**面板**主机，不是 App 的企业 API，该结论已在第 4 轮更正）。用用户提供的企业凭据文件里的**管理端账号**走原生登录流程登录成功（值是 `pbcopy` 直接从文件进剪贴板再 Cmd+V 粘入，**从未进入会话、日志或本文件**）。错误口令返回 typed `账号或密码错误`（不循环、不假登录）；正确凭据登录后进入已登录产品界面：侧栏（新任务/搜索/定时任务/能力中心/知识图谱 + 项目区）、页脚（用户中心/设置）、右上 `2.0.18 · 11,000 PTS`，且**升级路径保留的既有项目与会话仍在**（Movies / e-mate / DeepSeek Harness 三个项目及其会话）。 |
| B 会话与转录 | `BLOCKED`（被 AC-04 阻断：登录后主内容区空白） |
| C 生图 | `BLOCKED`（同 B；对照侧 DSH 原版已完成采样，见上一节） |
| D 知识 | `BLOCKED`（同 B） |
| E 画布/侧栏/宠物/屏幕 | 侧栏 `PASS`（见 A）；画布/宠物/屏幕 `BLOCKED`（同 B） |
| F 设置与更新 | `BLOCKED`（同 B） |
| G turn-fold 豁免 | 候选级 `PASS`，GUI 可见性 `BLOCKED`：`bundles/turn-fold` 在候选内；desktop `yarn check` 内置的 profile boot smoke 实测打印 `turn-fold: the served chat bundle carries the injected runtime; the file on disk does not`（即"服务出去的字节带补丁、磁盘上的不带"这一豁免核心断言为真）；折叠的肉眼可见性需要登录后的会话。 |
| H 移除项核对 | **`PASS`（候选级）**：`app.asar` 与 `app.asar.unpacked/build/e-mate-profile` 中 `dsh-plugin-computer-use`/`dsh-computer-use`/`dsh-plugin-tidychat`/`emate-tidychat` 命中数全为 0；`bundles/` 无对应目录；`bundles/registry.json` 命中 0。GUI 入口核对需要登录态。 |
| 性能三维度 | 生图对照侧已测（中位数 19330 ms / n=3）；处理侧与首响、多轮均 `BLOCKED`（同 A） |

## AC-04 登录后主内容区空白（`main.conversation` 槽条目崩溃）—— **FAIL（C2b）→ 根因定位并修复（`b687a97c4b`），待 C2c/C5 复测**

**现象**：以正确凭据登录 C2b 后，侧栏与页脚正常渲染，**主内容区（对话/首页座位）整块空白**，
点击会话条目也不切换（`effect.observedStateChanged` 始终 false）。

**证据（渲染进程 console，`ELECTRON_ENABLE_LOGGING=1`）**：

```
CONSOLE:56] "ReferenceError: pending is not defined"
CONSOLE:11570] "slot entry crashed in 'main.conversation': ReferenceError: pending is not defined"
```

第一条来自 `/assets/index-CH6ygWcq.js`（即 `@deepseek-ai/dsh-web-frontend@0.1.5-rc.1` 的 shell 资产，
第 56 行是 React 的错误上报代码 `function ll(e,n){...console.error(n.value)...}`），所以**抛出点在插件侧、
上报点是 shell**；第二条由 slot 注册表给出座位名 `main.conversation`。

**已完成的隔离（本轮）**：
- 该座位里 e-Mate 侧只有 shell 的 `registerRouteScopedConversationHeader` 会注册 `StandaloneProductSurface`（仅在独立产品路由下）；
- 对候选内**全部** e-Mate 客户端 bundle 做"自由标识符 `pending`"扫描：命中项全部是同作用域内的声明
  （`const pending = …` / 解构 / 类字段），没有跨作用域引用；
- 对 turn-fold 注入源 `upstream/plugins/dsh-turn-fold/inline-source.cjs` 做花括号深度分析：5 处 `pending`
  全部位于 `__ch4acko3DshTurnFoldSettingsCard` 函数体内（深度 1–3，函数在 726 行才闭合），
  即折叠运行时不是首要嫌疑；
- 把 `@e-mate/dsh-plugin-turn-fold` 从 profile bundle 列表移除后重启：因**未勾选"保持登录"**，
  会话没有持久化，App 回到登录页，无法在该轮观察主内容区（该实验需在勾选保持登录后重做；
  实验后 bundle 列表已恢复为 23 项）。
- 对照线索：同一个 pinned Harness 的 DSH 原版 GUI（`127.0.0.1:3180`，本会话所在界面）主内容区渲染正常，
  差异只可能来自 e-Mate profile 额外挂载的约 12 个客户端 bundle。

**根因（第 5 轮定位，实测）**：e-Mate 的 **harness conversation adapter**（`scripts/harness-conversation-adapter.mjs`）
在给 pinned `ConversationRoot` 注入 e-Mate CSS 钩子时，用了一个该编译作用域**从未声明的标识符**：

```js
change('\t\t\t\t"data-composer-seat": "",',
  '\t\t\t\t"data-composer-seat": "",\n\t\t\t\t"data-emate-has-interactions": pending.length > 0 ? "true" : "false",', 'canvas/interaction-seat')
```

`ConversationRoot` 真正声明的是 `pendingInteraction`（`SessionPendingInteraction | undefined`，
选择器是 `snapshot.get(sessionId)`，从 `ReadonlyMap` 快照取值 —— **是单个交互对象，不是列表**）。
于是会话座位第一次渲染就抛 `ReferenceError`，被 slot 注册表捕获后整块主内容区空白；侧栏渲染在别处所以仍然正常。

**为什么所有门禁都是绿的**：adapter 自己的测试把**错误文本**断言成了期望值
（`harness-conversation-adapter.test.mjs:676` 断言 `pending\.length > 0`），而没有任何门禁**在浏览器里执行这份被适配的
bundle**——即"测试把缺陷钉住了"。定位手段：用 TypeScript AST 对每个客户端 bundle 做**未绑定标识符**分析
（对 `pending` 逐个解析其所在作用域链是否存在同名绑定），唯一真阳性就在这份被适配的 ui-conversation bundle 里
（其余命中项都是 `const [pending, setPending] = useState()` 这类数组解构声明，属分析器假阳性，已复核）。

**修复（`b687a97c4b`）**：seam 改成读取原生绑定的存在性判断
`"data-emate-has-interactions": pendingInteraction === void 0 ? "false" : "true"`；测试不再钉字面量，而是
把发射出来的标识符**绑回原生声明**：

```js
const interactionAttribute = /"data-emate-has-interactions": ([A-Za-z_$][\w$]*)/u.exec(adapted)
assert.ok(interactionAttribute !== null, 'the interaction seat attribute is missing')
assert.match(adapted, new RegExp('const ' + interactionAttribute[1] + ' = useSessionPendingInteraction', 'u'))
```

**实机因果验证（诊断式，非候选复测）**：把同一处 seam 按位施加到已安装 C2b 的
`app.asar.unpacked/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 后重启登录 ——
主内容区**完整渲染**：e-Mate 首页主视觉「和小芯一起开始工作吧」、四张快速开始卡
（小红书笔记创作 / 计划方案撰写 / 快速外部连接 / 深度数据分析）、
「探索未至之境 预览版」输入区（模型 chip、专家模式 / 外部连接 / 通用会话、发送按钮），
侧栏与项目/会话列表同时可用。截图留档（不入库）：
`~/.dsh-computer-use/artifacts/session-27e2cf42-7243-4aad-a60b-4065c4b0d9ef/observation-f65e2afd-0503-4b2c-b7e6-051e41cc5b1f.png`。

**正确性旁证**：`node scripts/harness-provenance.mjs sync-desktop` 与 `verify-desktop` 均 EXIT 0
（后者会把桌面侧 bundle 与"pinned 原生 + 产品适配器"逐字节比对），`test:fast` 68+39 全绿。

**下一步**：C2c（macOS）与 C5（Windows）以此源码重建后复测本条，然后继续 B–F 组与三维度性能测量。

## 附录：本机实机操作的复现配方（不含量值）

1. 启动：`open -a e-Mate`（**必须**走 LaunchServices；直接执行 `Contents/MacOS/e-Mate` 会走 web 模式并打开系统浏览器，
   窗口不出现）。启动后 `127.0.0.1:3080` LISTEN。
2. 让 Computer Use 能用：先 `osascript -e 'tell application "e-Mate" to activate'`。
   目标 App 不是 frontmost 时，坐标点击会落到进程但没有焦点、`computer_press_key` 的粘贴也不会生效
   （实测：`agentCursor.reason = "the bound target application is not frontmost"`）。
3. 登录（窗口 1280×787，`coordinateSpace: window`）：
   账号框 `(992, 353)`、密码框 `(992, 430)`、`登录` 按钮 `(992, 533)`、`保持登录` 复选框 `(778, 483)`。
   凭据来源：用户提供的私有文件（值只经 `pbcopy` 从文件进剪贴板、再 `Cmd+V` 粘入，**从不打印**）：
   管理端账号/密码取自 `~/Desktop/e-Mate-管理端与审计面板账号.txt` 第 6、7 行。
   **先勾选"保持登录"**（否则重启即回到登录页，每轮隔离实验都要重新登录）。
4. 关掉再改 profile 做隔离时，别忘了把 `profiles/e-mate/package.json` 的 `dsh.profile.bundles` 改回去
   （本轮已还原为 23 项，含 `@e-mate/dsh-plugin-turn-fold`）。

## Windows 候选 C4 —— 候选级完成，实机安装 `OPEN`

`dist/e-Mate-2.0.18-win-x64-Setup.exe` 335410291 字节 / sha256 `67797411…`；
`dist/win-unpacked/e-Mate.exe` 225577472 字节 / sha256 `ab3cbd85…`；
构建自带校验通过（`packaged node-pty smoke passed`、`Windows installer verification passed`），构建 `EXIT=0`。
**未安装**：按 AGENTS.md，Windows 的安装态 GUI 验收必须在**已登录的交互式会话**上完成，
远程命令回执不构成安装验收。故 C4 的安装态一律 `OPEN`。

## 本文件不声称什么

它不声称任何候选已通过验收。C1 已被 AC-01 判为 `FAIL` 并作废；在 C2/C4 完成实机用例之前，
2.0.18 的实机状态一律 `OPEN`。
