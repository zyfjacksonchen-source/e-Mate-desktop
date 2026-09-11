# Mounting the turn-fold provider: the seat that makes the exemption real

**中文摘要**：AGENTS.md 给 dsh-turn-fold 的豁免此前只有"机制与守卫"，**产品并不加载它**——本包不在
组件清单里，而且即便装上，上游的 host entry 注入的是 0.1.5 不存在的 `harmony` 服务，行会永远
PENDING。本轮把三件事补齐：(1) 座席（把打过补丁的 bundle 从内存交给浏览器）；(2) e-Mate 自有的
host entry（不再注入 harmony）；(3) 组件清单挂载。同时查清并修掉两处此前未记录的事实。

## 1. 缺口：驱动有实现，但没有调用者

`transformClientBundle()` 在本轮之前**只有测试调用**（`test/transform.test.mjs`、
`test/runtime.test.mjs`）。产品侧没有任何东西会调用它：

- 上游 host entry `index.cjs` 声明 `inject: ['harmony']`；0.1.5 没有任何包提供该服务，
  所以行即便被挂载也会**永远 PENDING**，`apply` 从不执行。
- `cordis.patch.yml` 的行本身不注入，但插件的 `inject` 来自**模块**，不是行。

因此"把包挂进清单"本身不足以让产品加载它——这也是本轮把座席一并实现的原因。

## 2. 座席：为什么是一个更窄的 prefix 路由

选定的实现是：注册 `{ kind: 'prefix', path: '/plugins/@deepseek-ai/dsh-client-ui-chat' }`。

- Web server 的 `register` **只拒绝完全相同的 (kind, path)**（`host/webserver/src/index.ts:160-172`），
  分发是**最长前缀优先**（`:317-326`）。注册模块自己拥有 `/plugins`，而本包注册的是它下面
  更深的一层，所以这是"多一个 owner"而不是"抢走 owner"或"第二个 owner"。
- 处理函数把每一个资源都交回 registry 自己解析（`clientModules.fetchBundle`），所以未知路径仍是
  registry 的 404、`rev`/缓存头保持 shell 已发布的那一套；**只有目标 bundle 的字节被替换**。
- 补丁**只在内存**：`transform.cjs` 读原字节、校验摘要、在内存改写并返回文本，
  `assertParses` 复现浏览器解析这一步；座席把它当作响应体送出，**从不落盘**。

## 3. 两处此前未记录的事实（本轮查清并修掉）

### 3.1 产品服务的是**被适配过**的 bundle，不是固定版原件

`harness-provenance.mjs:412-417` 在装配 Desktop client 闭包时会用
`harness-conversation-adapter.mjs` **改写同一个** `@deepseek-ai/dsh-client-ui-chat/lib/client.js`。
实测：

| 位置 | 字节 | sha256 |
|---|---|---|
| 固定版 checkout（pin 的原件） | 370637 | `cf53ae8f…ba97` |
| 装配后的产品闭包（真正被服务的） | 380708 | `f8677868…9a732e` |

**只钉原件会让产品永远拒绝**：座席拿到的字节不在已验证集合里。因此
`src/select.cjs` 增加了第三个家族 `ASSEMBLED_BUNDLE_SHA256`（装配后的产品 bundle，按平台），
并**在授权之前重新核验**：用 `evaluateSeams`/`evaluateHostSymbols` 对装配后的字节实测，
三个选择器各命中**恰好一次**（行 2230 / 2693 / 8445），六个宿主符号全部解析。
pin 仍是"一个值只写一处"，移动它的纪律不变（先手工复核选择器，再移动摘要）。

### 3.2 vendored `index.cjs` 不再出货

上游 `index.cjs` 未修改，但**不再被打包**：`scripts/shipped.mjs` 把它从 `VENDORED` 移到
`EMATE`，由 `src/index.cjs` 取代（保留上游的 settings 注册，去掉 harmony 注入，加上座席）。
`upstream/plugins/dsh-turn-fold/SOURCE.md` 的"Local modifications"此前写着 **None yet**，
而 `inline-source.cjs`/`patch.cjs` 早已被改过——清单里的两个 sha256 与实际不符。
本轮把两处修改逐条记入，并把两个摘要改成实测值；现在 17 行清单 0 mismatch。

## 4. 驱动扩展：座席如何拿到"要服务的那个文件"

安装后的产品**没有 Harness checkout 可以遍历**。因此：

- `transformClientBundle({ sourcePath })` 新增：直接针对"即将被服务的那个文件"解析目标，
  并从**该 bundle 自己的闭包**解析 TypeScript 编译器（`createRequire(<pkg>/package.json)`），
  而不是从 checkout 解析。`locateServedTarget()` 还会校验该 bundle 的清单名确实是目标包。
- 座席用 `clientModules.clientPath(TARGET.package)`（**公开方法**）取得该路径。
  拿不到路径就没有补丁目标：记录一条 warn 并正常返回，产品照常启动。
- 两条入口（构建期检查器走 checkout、座席走服务文件）**汇入同一个摘要闸门**，
  谁也绕不过它。

## 5. 拒绝语义（fail-closed）

摘要不在已验证集合内、或选择器命中次数不为 1、或产出无法解析时，`transformClientBundle` 抛错，
座席捕获后**不注册任何路由**：产品继续服务**未打补丁**的 bundle，能力缺失而不是错误地上线。

已实测的拒绝路径（`test/package.test.mjs`）：

- 服务文件清单名是目标包、但字节不是已验证摘要 → 不注册路由；
- `clientPath` 返回 undefined（registry 不认识该包）→ 不注册路由；
- 两条拒绝各记录一条 warn。

## 5.1 座席实现过程中修掉的一个真实缺陷（值得记）

座席最初用 `body.replace(before, after)` 改写 combo 文本。固定版 client bundle 里**恰好有一处**
`$` + 反引号（偏移 **425554**，模板字面量的尾巴），而 `String.prototype.replace` 会把它当成
**替换模式** `$` ` `（"匹配点之前的文本"）来解释，于是那两个字符被静默删掉，服务出去的 bundle
**不再能解析**——桌面启动冒烟在 `runInThisContext` 抛出
`SyntaxError: missing ) after argument list`，报错行正是那一行。

- 修法：改用**函数替换器** `body.replace(before, () => after)`。
- 守卫：`test/package.test.mjs` 断言服务出去的 combo 里 `$` + 反引号**恰好出现 1 次**（旧代码为 0）。
- 教训：文本改写一律不用替换字符串；这条缺陷在单元测试里**看不出来**，是端到端启动冒烟发现的
  （单元测试的替身此前也用过同一个错误形状）。

## 6. 已实测的端到端事实（本轮）

`cd desktop && corepack yarn workspace @e-mate/desktop run verify:profile` → **EXIT 0**，并打印：

```
turn-fold: the served chat bundle carries the injected runtime; the file on disk does not
```

这条断言的两半都承重：服务出去的 chat bundle 必须带注入的 runtime（否则"装了但不生效"就红），
**磁盘上的同一个文件必须不带**（否则"只在内存"这条豁免条件就红）。它在
`verify-profile-boot.mjs` 里，所以 `yarn check` 会一直看着它。

## 7. 尚未完成 / 未验证

- **Windows 装配摘要缺失**：`ASSEMBLED_BUNDLE_SHA256` 目前只有 darwin 一条。
  Windows 候选构建完成后必须补入其装配摘要，否则 Windows 上座席会拒绝（fail-closed，可检出）。
- **实机未验**：本文件不声称 Windows/macOS 上折叠真的可见。需要在实机安装验收里确认
  （展开/折叠、运行中轮次、失败轮次、settings 卡）。
- 座席把 `content-length` 改成补丁后的长度，但 registry 的 `rev` 仍描述未打补丁的字节；
  这不会破坏加载（URL 与内容稳定），但严格说 rev 不再描述内容。
