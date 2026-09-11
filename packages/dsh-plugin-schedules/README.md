# @e-mate/dsh-plugin-schedules

e-Mate 的定时任务管理投影插件。它只从 DSH 0.1.5-rc.1 原生 Session/Schedule 事件生成跨会话只读列表、一次性任务完成记录和最近执行记录；创建、执行、删除、计时器和持久化仍由 `@deepseek-ai/dsh-schedule` 负责。

管理界面通过同一 Profile generation 中的 e-Mate Shell 调用 loopback RPC。插件不创建第二套调度器、任务表或执行通道。

0.1.5-rc.1 的原生事件只有 `create`、`delete`、`dispatch`，所以当前原生可证明的状态只有 `scheduled`、`overdue`、一次性任务 `completed` 及 `dispatch` 执行记录。它没有 pause、resume 或 edit 事件；修改继续由 Agent 在所属会话中先创建替代任务、成功后删除旧任务，不伪造暂停态或并行写入口。
