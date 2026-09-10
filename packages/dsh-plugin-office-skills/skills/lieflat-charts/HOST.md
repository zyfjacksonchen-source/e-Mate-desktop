# Lieflat Charts：e-Mate 宿主适配

本 Skill 的真实绝对资源目录：{{SKILL_DIR}}

- 以下上游说明里的 catalog、gallery、报告、配色与脚本路径都相对于该资源目录。按需读取所选模板；资源目录只读，生成和修改均保存到当前任务工作区，保留用户输入原件。
- 沿用当前 Agent 的原生文件、浏览器与附件能力。HTML 是主要产物；使用现有文件工具保存真实文件，以当前任务原生产物/附件路径交付可打开的文件链接。不要把资源目录里的模板链接、源码代码块或不存在的路径当成最终产物。需要读取办公数据或输出办公格式时，先加载 univer，再加载对应 Unit Skill（表格用 univer-sheet、文档用 univer-doc、演示文稿用 univer-slide），按其契约复用现有 univer_* 工具；按需导入、检查和导出，不新增工具或运行时。
- 所有 gallery、配色、交互大图、地图和双语报告均已预置。需要执行本地 JavaScript 时，使用原生 Shell 环境中的 DSH_EMATE_NODE：Bash 使用 `"$DSH_EMATE_NODE" script.mjs`，PowerShell 使用 `& $env:DSH_EMATE_NODE script.mjs`；无需查找系统 Node 或安装运行时。上游 scripts/validate.mjs 只检查随包模板仓库的完整性，不接受本次生成 HTML 作为验证目标，不是每次交付的必跑步骤。scripts/smoke-new-charts.mjs 是依赖全局 Playwright/Chromium 的开发烟测，不默认具备该依赖，也不要为此擅自全局安装；客户端实际验图沿用现有浏览器能力。按本次任务需要检查文字、数据、交互和溢出；静态检查通过不能作为已经实际打开或测试交互的证据。
- 纯 SVG 可离线。使用 Chart.js、ECharts、GeoJSON 或在线字体的模板未内联依赖时需要联网；沿现有网络设置访问，不擅自更改代理。离线交付须保留所需依赖和许可，并实际断网验证；不得默默删除交互、地图或字体来声称完整离线。
- 保留原版模板选择、事实来源、语言及配色要求。只根据真实输入组织图表，不将模板样例数字当作用户数据。

以下为保留上游方法、移除可选交付署名提醒的 Skill 内容。
