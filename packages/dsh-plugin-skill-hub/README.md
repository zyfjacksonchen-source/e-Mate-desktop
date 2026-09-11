# @e-mate/dsh-plugin-skill-hub

e-Mate 的 DSH 原生 Skill Hub 组件。Host 事务、Agent 自然语言 Tools、Jobs、原生 Skill provider 回读和能力中心 UI 由同一版本交付。

- 安装、更新、启用、禁用和卸载只操作带精确 Hub receipt 的本地 Skill。
- 上传、发布和远端删除使用当前 e-Mate 身份；服务端仍是所有权真相源。
- 所有 Agent 变更在副作用前通过 DSH `userQuestions` 显示精确动作、slug、版本和摘要。
- 候选必须由固定 0.1.5-rc.1 `skill-filesystem` 解析并在 active 路径回读后才能提交。
- Host 和 Client 共用 schema-version 1 的 `success` / `failure` 结果；未知 discriminator、上游正文和校验库诊断只投影为有界失败。
- 不实现第二套 Agent、会话、Tool、Job、Skill loader 或浏览器传输。
