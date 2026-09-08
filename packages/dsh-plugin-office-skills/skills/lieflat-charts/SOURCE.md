# Lieflat Charts 来源与分发依据

固定来源： https://github.com/larashero3-dotcom/lieflat-charts/tree/eace082a317b696c5570c25826a53a7fa113e984

完整上游文件均保留原字节，包括 Skill、所有 gallery、配色、12 套双语报告、示例、预览图、验证脚本与许可证。`UPSTREAM.json` 列出逐文件字节数、SHA-256 和 Git blob 身份，以及下载归档摘要。没有替换或删除上游功能。npm 随包清单按其标准规则省略上游 `.gitignore`（仅开发忽略规则）；源码保留该文件，其余 124 个上游文件以及 3 个宿主/来源文件全部进入包清单。

2026-09-08，本任务用户明确确认：“Lieflat 已有企业授权 正常随包预置即可”。e-Mate 2.0.18 随包分发以该企业授权确认为依据；本记录不是授权合同，不表示上游通用许可证变为 MIT，也不向其他分发者授予同等企业权利。原 `LICENSE`（PolyForm Noncommercial License 1.0.0）及 `THIRD_PARTY_NOTICES.md` 保留原貌。

唯一宿主补充为 `HOST.md`，通过已有 Skill provider 前置，不修改上游 Skill 文件。使用当前任务、文件、浏览器和附件通路，没有额外 Tool 或模型运行时。

上游 `scripts/validate.mjs` 只使用 Node 标准库；`scripts/smoke-new-charts.mjs` 是开发烟测，需要全局 Playwright 与 Chromium，未将它们作为客户端新运行时预置。客户端真实验图沿用现有浏览器能力。纯 SVG 可离线；Chart.js、ECharts、在线字体和地图 GeoJSON 的模板在未内联依赖时仍依赖网络。模板存在与静态验证不等于真实浏览器渲染、安装发现或最终文件交付已验收。
