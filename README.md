# e-Mate

e-Mate 桌面应用的 `2.0.17` 是 [GitHub `e-Mate-desktop`](https://github.com/zyfjacksonchen-source/e-Mate-desktop) 的当前源码目标，基于固定 `@deepseek-ai/dsh@0.1.5-rc.1`、Harness `8cc7914c51a063cd2b851a9eb956c72b4c16471b` 与 `deepseek-harness-desktop@166c16cfc38c51d32c2316715548c0f8271db517`。稳定 Electron `productName`、应用名称和安装位置仍为 `e-Mate`；“Desktop”只描述桌面产品与仓库范围。这些身份只说明源码合同，不表示候选包、安装验收或公共发布已经完成。

> 仓库第一准则见 [`AGENTS.md`](AGENTS.md)，当前边界见 [`docs/target-contract.md`](docs/target-contract.md)。官方下载页只指向已通过安装与公开回读的正式字节。

## 下载与安装

只有在精确 macOS 与 Windows 字节完成安装验收、Cloudflare/R2 不可变对象和官方指针均被公开回读后，才从 [e-Mate 官方下载页](https://dl.ecoremedia.net/e-mate/update/) 获取正式安装包。本 README 不宣称 `2.0.17` 已满足这些门禁。

- macOS 13+，Universal（Apple 芯片与 Intel Mac）。
- Windows 10/11 x64。
- Linux 不属于 `2.0.17` 目标支持范围。

用户不需要安装 Node.js、npm、pnpm、Python、Electron、Xcode、MSVC 或 Rust。目标 macOS 和 Windows 安装包均明确按未签名分发处理；只应使用激活后的官方下载页所列不可变 R2 地址并核对 SHA-256。macOS 首次安装按下载页的“未签名安装图解”将 e-Mate 拖入“应用程序”，再通过 Control 点按选择“打开”；页面同时提供只针对 `/Applications/e-Mate.app` 的备用命令。应用不会关闭 Gatekeeper，也不会伪装 Developer ID 或公证状态。

浏览器自动化由 `@e-mate/dsh-plugin-cdp` 连接用户已有 Chrome。它不安装扩展，不需要 `chrome://extensions`、开发者模式或“加载已解压”；首次使用只需按 Chrome 自身安全要求开启远程调试，并选择明确的本机 CDP 目标。

## 更新方式

安装后，用户可点击托盘“检查更新”，也可直接对 Agent 说“检查更新”或“更新 e-Mate”。自然语言入口只调用 `desktopUpdates.runInteractiveUpdate()`，与后台和托盘共用 dsh-desktop 的同一个 lifecycle，不持有 URL、下载、安装、替换或回滚逻辑。

原生 lifecycle 只接受严格更高的稳定版本。用户确认后，macOS 下载并打开未签名 DMG，由用户覆盖安装；Windows 启动同一个 assisted NSIS 安装器完成全新安装或覆盖安装，并有序退出当前应用。不受支持的旧版本和同版本不同字节统一从官方下载页手动迁移，客户端不会伪造在线更新。

## 插件与权限边界

- `danger-full-access` 只表示 pinned DSH sandbox 定义的文件效果范围，不等于 macOS TCC、Computer Use 应用 lease、CDP 目标授权、凭据、Skill 安装或 MCP 持久进程授权。
- `approval/policy: never` 表示需要 `ctx.approval` 的操作被拒绝，不表示自动同意。
- Computer Use 只接受插件设置中的 `allowAllApps`、精确应用 grant，或原生交互 lease；e-Mate 不把 Full Access 映射为全应用授权。
- `find-skill` 只负责发现。Skill 的安装、更新、启用、禁用、卸载、上传和删除统一由 Skill Hub 的版本/SHA/WAL 事务处理。
- 企业管理端负责鉴权、受管模型/搜索策略、有界凭据租约与异步脱敏审计，不得控制本地插件、工具审批、会话、Job 或执行。
- 管理员可在模型路由页手动发起一次最小真实联通测试：文本路由仅请求 32 Token 的固定回复，图片路由仅生成固定橙色方块。请求只经同源 Model Gateway 的短期管理会话，计入配额与脱敏审计，不传入 Tool schema、不暴露上游 Key、不保存生成内容，也不调用本地 Harness。

## 证据边界

- **源码：** 只证明已审查的源码差异与具名最窄测试，不证明安装包。
- **候选：** 只证明授权原生构建的精确源码、固定 pins、平台字节与 SHA-256，不证明安装。
- **已安装：** 只证明相同字节在本地 macOS 与已登录 Codex Remote Windows 机器完成安装、原位替换和启动；SSH 不属于该证据路径。
- **公共生产：** 只在 Cloudflare/R2 不可变对象及官方版本/平台指针激活并公开回读后成立；GitHub 提交、CI、artifact、tag 或 release 不能替代它。

任一事实缺失或不匹配即 fail closed，并保持 `OPEN`。不得用源码测试、fixture、另一候选、历史回执或口头批准跨越证据层。

## 开发与发布

主代理是唯一监督管理者，负责 worktree、基线、互斥写集、工单、审查、整合、证据门禁、安装验收、发布和回滚。子代理只在工单写集内开发并运行最窄相关测试，不得自行扩域、改版本、构建安装包、安装、部署、推送、清理或判断发布合同已通过。

Harness 输入继续使用 Node 24.x 与精确 `pnpm@11.8.0`。经主代理授权时，桌面封装只使用 dsh-desktop 的 Yarn workspace 命令：

```bash
cd desktop
corepack yarn install --immutable
corepack yarn dist:mac
corepack yarn dist:win
```

macOS 在本机原生构建，Windows 只在已登录的 Codex Remote Windows 机器上原生构建，不经 SSH。GitHub `e-Mate-desktop` 只承载源码身份、审查与源码 CI，不是安装验收或公共发布传输；Cloudflare/R2 才是公共生产交付边界。精确双平台字节完成安装、覆盖和启动验收后，先上传并回读不可变对象，最后激活官方版本指针。仓库不保留平行 UI/store/router/transport/updater/fallback，也不恢复 schema-2、Profile 热更新、二次签名或另一套 Desktop 发布器；发现偏离即删除并回归原生 owner。
