# @e-mate/dsh-plugin-file-import

将本机普通文件导入当前会话绑定的 Workspace，并通过 `dsh-at-file` 的现有 `@相对路径` 合同交给 Agent。

- 仅 loopback 可用；远程 Web 客户端失败关闭。
- 支持 `ALLOWED_MEDIA_BY_EXTENSION` 当前列出的办公文档、PDF、文本/结构化数据、ODF 和常见归档；拒绝未知、脚本、可执行文件、安装包和目录，不宣称支持任意扩展名。
- 普通文件只按 NFC 规范化后的扩展名决定 canonical MIME，不信任 Browser MIME，也不为某一种文件类型建立单独路径或协议；零字节文件受支持。
- 每次最多 8 个文件，单文件最多 16 MiB、总计最多 32 MiB；文件名保留跨平台、隐藏名、设备名和 160-byte 检查。
- 文件原子写入当前 Workspace 的 `.e-mate/imports/`，同名文件安全加后缀，批次失败时回滚且不覆盖既有文件。
- 浏览器只得到规范化文件名、canonical MIME、字节数和 Workspace 相对路径；不会得到本地绝对路径或摘要 ID。
- 预期校验返回 pinned 0.1.5-rc.1 `bad-request`；意外 Host 异常返回固定 `internal` 文案。客户端严格解析结果，仅显示 allowlist 内有界业务校验文案，其余 RPC、transport、Zod 或未知失败统一显示固定安全中文。
- UI 的“导入中 / 已就绪 / 失败”只来自真实 RPC 生命周期；图片通过既有 loopback `/emate.fileImport` channel 的 `stage-images` 操作暂存，并且必须属于目标 Session 绑定的 Workspace。
- 图片字节只交给 native Attachment CAS；Host 仅把返回引用写入 ref-only、ignorable 的 Session 授权事件，并在该事件成功 flush 后返回暂存结果。flush 完成即提交，即使随后取消也返回引用；save 后、flush 前失败可留下 native CAS 允许的不可达对象。事件与响应均不含 base64、本地路径或原始字节。
- 既有 session-scoped `dsh.conversation.chat.<sessionId>` Store 只持久化有界 `{schema_version:1,draft_key,attachment}` 引用元数据；绝不持久化 `File`、base64、blob URL 或 native runtime image id。
- 选择图片即接受本次暂存：RPC 进行中不可从临时行移除，成功关联后由 native image card 负责移除。一个 active AbortController 将 Session 切换/卸载与 native 120 秒本地暂存上限通过 AbortSignal.any 合并传给 RPC；runtime-only stage reservation 与未 hydrate 引用都会阻止 SessionInputShell 提交，且 reservation 永不持久化。
- 冷恢复通过目标 Session 的 `session.attachment` 读取并复核 CAS 引用与实际字节，再创建全新的 native runtime id。确定损坏/缺失/未授权的引用移除一次；transport、internal、临时读取或 native 创建/关联失败保留引用并显示显式“重试恢复 / 移除”操作，不轮询也不定时重试。
- 图片遵守 live native policy，并受单图 5 MiB、每条消息 20 图、合计 100 MiB 的硬上限约束。该实现不新增 Store、transport 或 channel。
- `scripts/component-run.mjs check` 先执行 package `build`，再执行 `test`；`test` 串行运行 `test:source` 与 canonical `test:client`，`check` 只组合 `build + test` 而不重复 client；该 adapter/client 自检依赖已构建的 pinned 0.1.5-rc.1 `ui-conversation/lib/client.js`，不能宣称在没有该构建产物的 clean source worktree 中直接运行。
