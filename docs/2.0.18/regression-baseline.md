# 回归参照集：2.0.18 基线（rc.7 / 3cc4be84）实测

本文件是**回归验收的参照基准**。用法：升级到 0.1.5-rc.1 后重跑同一组检查，
凡"基线通过、升级后失败"的项即判定该 bug 复现（无论形式是否相同）。

## 1. 环境（必须一致，否则参照无效）
| 项 | 值 |
|---|---|
| 工作树 | `worktrees/emate-2.0.18-rc7-tidychat` |
| 提交 | `3cc4be844607d4f11a4aa5d832a41c9c2dc33825` |
| harness 子模块 gitlink | `4da69d7c3522ee51de12822c917c503a124f7a7d` |
| harness 子模块 checkout | 必须同为 `4da69d7c3522…`（见第 3 节陷阱） |
| 子模块工作区 | 干净（0 个改动） |

## 2. 参照结果
```
corepack pnpm run test:fast
EXIT=0
tests 71  pass 71  fail 0
tests  5  pass  5  fail 0
```
**基线全绿。**

## 3. 陷阱（本轮实际踩到，必须记住）
第一次跑基线时结果是 **70 通过 / 1 失败**，失败项断言 harness 提交号：
`actual: 1d3824bcd340…` vs `expected: 4da69d7c3522…`。

**原因不是代码，是做法**：我用 `worktrees/emate-2.0.18-rc7-tidychat/upstream/deepseek-harness`
这个共享克隆做调查时把 checkout 切到了 `1d3824bcd340`，而该 worktree 的 gitlink 是 `4da69d7c3522`。
恢复 checkout 后即全绿。

**因此：跑任何基线/回归检查前，先确认子模块 checkout 等于 gitlink，且工作区干净。**
否则会把"自己造成的扰动"误判成"基线缺陷"或"升级引入的回归"。

## 4. 守卫文件在新树中的可得性
`regression-ledger.json` 的 151 个守卫文件里，**122 个存在于 2.0.18 基线树**，29 个不存在（属未集成分支）。

122 个按区域：
| 区域 | 数量 |
|---|---|
| packages/dsh | 23 |
| desktop/e-mate-desktop | 19 |
| enterprise/apps | 18 |
| tests/performance | 14 |
| packages/dsh-plugin-knowledge | 8 |
| packages/dsh-plugin-canvas | 6 |
| packages/dsh-plugin-pet | 4 |
| tests/quality | 4 |
| packages/dsh-plugin-skill-hub | 3 |
| 其余插件 | 各 1–2 |
| **scripts/harness-*-adapter.test.mjs** | **6**（harness 源码适配器自身的守卫） |

最后一行与"重 derive 6 个 harness 源码适配器"直接对应：**改适配器的同时，它们的 6 个测试就是回归门禁。**

## 5. 复现命令
```sh
cd worktrees/emate-2.0.18-rc7-tidychat
git -C upstream/deepseek-harness rev-parse HEAD      # 必须 = 4da69d7c3522…
git -C upstream/deepseek-harness status --porcelain   # 必须为空
corepack pnpm run test:fast                           # 期望 EXIT=0, 71/71 + 5/5
```
