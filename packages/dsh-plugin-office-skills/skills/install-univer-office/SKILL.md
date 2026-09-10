---
name: install-univer-office
description: 发现并按需安装 e-Mate 的 Univer 办公插件，供缺少办公能力时创建、编辑和交付 Excel、Word、PowerPoint、多维表格与画布。
---

# 按需安装 Univer Office

先查看当前可用的 `univer_*` 工具和 `univer` Skill。若它们已经加载，直接使用 `univer` 及对应的 Unit Skill 完成用户任务，不重复安装。

缺少能力时，通过 `tool_search` 找到 `dsh_plugin_manage`，调用 `action: "list"`。使用返回的可信可选目录，目标包为 `@e-mate/dsh-plugin-univer-office`。目录只代表可以安装；已安装记录也不等于插件已成功加载。当前平台不受支持时说明具体限制，不尝试安装其他架构的包。

用户需要启用该能力时，调用 `dsh_plugin_manage`，参数为 `action: "install"`、`packageName: "@e-mate/dsh-plugin-univer-office"`。由原生流程确认安装及重启、校验固定归档并保存 profile 恢复快照。沿用已有安装授权，不另外发起一轮相同的确认。不要自行选择 npm latest、GitHub 分支、URL、本地归档或 Shell 安装命令；上游当前 npm 包面向较新 DSH，不能替换此 rc.7 适配包。

安装回执中的 `restart: "scheduled"` 表示等待重启。返回用户后，由重启后的任务检查 `univer` Skill 与实际工具是否可用，再继续原办公任务；不要在当前旧进程中反复安装，也不要宣称文件已生成。

工具加载后先加载 `univer`，再按内容类型加载 `univer-sheet`、`univer-doc`、`univer-slide`、`univer-base` 或 `univer-board`。使用其原生草稿、审阅、导入导出与验证流程。实际读取、导出和打开结果才构成任务交付。
