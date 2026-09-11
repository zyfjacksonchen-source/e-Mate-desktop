# e-Mate Tool Search

基于 DSH 0.1.5-rc.1 `agent.ctx.tools.restrict()` 的逐会话工具渐进披露组件。标准 Native Tool Mode 初始只展示常用工具与 `tool_search`；搜索命中后，原始 Tool 定义会在下一模型步骤恢复可见。

组件不代理 Tool 调用、不改变权限，也不写自定义 Session 事件。会话恢复只读取 DSH Agent Loop 已持久化的 `request/header.tools`；Code Mode 保持其原生 SDK 披露路径。

原生 `web_search` 由 Profile 的 0.1.5-rc.1 Web seam 与 `deepseek-official` Provider 直接提供，并保持初始可见；本组件不注册第二个搜索 Provider 或搜索 Tool。
