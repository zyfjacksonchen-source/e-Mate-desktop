# 2.0.18 实机验收回执（本机 macOS）

方法与判定口径见 `docs/2.0.18/field-acceptance-plan.md`。本文件只记录**实际执行**的用例与结果。
判据只允许 `PASS / FAIL / BLOCKED / NEEDS_EVIDENCE / OPEN / OUT_OF_SCOPE`。

## 0. 候选身份

| # | 平台 | 源码 HEAD | DMG 字节 | DMG sha256 | 状态 |
|---|---|---|---|---|---|
| C1 | macOS | `a10b485f06` | 466413297 | `65cef6f47e6a5d1c03146472cd75c85c4288d170cf953a47d905646232e6c98b` | **已作废**（见 AC-01） |
| C2 | macOS | `5bed0f831b` | 构建中 | 构建中 | 待验收 |
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

## 其余用例

| 组 | 状态 |
|---|---|
| A 登录与企业 | `OPEN`（C2） |
| B 会话与转录 | `OPEN`（C2） |
| C 生图 | `OPEN`（C2） |
| D 知识 | `OPEN`（C2） |
| E 画布/侧栏/宠物/屏幕 | `OPEN`（C2） |
| F 设置与更新 | `OPEN`（C2） |
| G turn-fold 豁免 | `OPEN`（C2；C1 已具备承载，但未实测可见性） |
| H 移除项核对 | `OPEN`（C2） |
| 性能三维度 | `OPEN`（C2） |

## 本文件不声称什么

它不声称任何候选已通过验收。C1 已被 AC-01 判为 `FAIL` 并作废；在 C2/C4 完成实机用例之前，
2.0.18 的实机状态一律 `OPEN`。
