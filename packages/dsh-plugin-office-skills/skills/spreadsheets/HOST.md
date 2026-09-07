# Spreadsheets：e-Mate 本机适配

本 Skill 的真实绝对资源目录为：{{SKILL_DIR}}
所有相对说明、脚本和图标路径均从该目录解析，不假设当前项目包含 Skill 文件。

## 原版允许的执行路径

- 当前 e-Mate 不提供或分发 `@oai/artifact-tool`。原版明确允许在该工具不可用时使用 `openpyxl`、`xlsxwriter` 或 `pandas.ExcelWriter`；本机优先使用已接通且验证可用的 `openpyxl` 路径，保留原版的工作簿设计、公式、保真和验收要求。
- 使用 Host 提供的 `DSH_EMATE_PYTHON`：POSIX shell 用 `"$DSH_EMATE_PYTHON"`，PowerShell 用 `& $env:DSH_EMATE_PYTHON`。先确认该可执行文件和本次需要的 Python 包真实可用；每个路径作为完整参数传递。缺少依赖时沿用宿主管理流程，不修改受管依赖或 Skill 目录。
- 不调用 Codex 专属 `load_workspace_dependencies`，不搜索或复制用户的 Codex 私有缓存，不构造同名 `Workbook`、`workbook.recalculate()` 或 `workbook.render()` 空实现。原版附带的 `artifact_tool_docs/` 保留为来源参考，不能据此声称运行库已安装。
- 本次材料替换不代表 openpyxl、重算引擎、渲染工具或外部连接已接通。执行前以实际 Host 状态与真实检查为准；无法完成的步骤须明确说明。

## 现有 Office Tool 重算与 PDF 输出

使用已有 `office_write`：`format="xlsx"` 或 `format="pdf"`，匹配扩展名的 `filename`，以及 `document={"operation":"recalculate","source_path":"工作簿.xlsx"}`。输入必须是当前任务工作区内普通 XLSX 文件。PDF 先经同一 Calc 重算再导出；输出经原有 Job 和附件路径保存为新文件，同名自动避让，不覆盖原件。

此路径仅在 Host 实际提供有效绝对路径 `DSH_EMATE_CALC` 和 `DSH_EMATE_CALC_FONTS` 且对应受管程序、字体存在时可用；缺失会明确失败，不从 PATH 寻找其他安装，也不能由本指南推断安装包已包含运行时。宏、嵌入对象、外部数据或主动公式等不支持的内容会拒绝处理。单次超时 120 秒，输入与最终发布文件上限 32 MiB。

完成 XLSX 后用 `office_read` 核对真实缓存值，并检查输入变化、跨表公式及错误值。PDF 仍按 PDF Skill 渲染并目视检查中文、分页、图表和样式；转换退出成功不代表视觉保真或全部 Excel 功能兼容。

## 公式、保真与可见结果

- openpyxl 可以读写 XLSX 及公式，但不能自行计算公式结果或渲染工作表。设置“打开时重算”、写入静态缓存、生成 PASS 单元格或仅比较公式文本，都不算重算验收。需要通过 Host 实际提供且验证可用的计算/渲染路径检查结果；没有该能力时不能报告公式和视觉检查通过。
- 保留原版要求的输入变化、边界值、跨表依赖、错误值及影响范围检查。任务需要特定 Excel 原生功能时，确认当前库能保留；不支持的宏、控件、复杂图表或旧 `.xls` 格式不能伪装为已保留，更不能只改扩展名交付。
- 用户的原件不变，编辑输出写到当前任务工作区的新文件。明确限定的修改还需核对其他工作表、公式、样式和对象；不得因选择备用库而放弃原版验收标准。

## 标记与交付

- 原版 `container_tools/mark_artifact_operation_started.mjs` 用已有原生 Node 和资源目录下的绝对脚本路径调用。它只校验操作类型、数量、输出格式；退出成功不是创建、导出、渲染或发布产物的证据。
- e-Mate 不消费 `:codex-file-citation{...}`。将最终真实工作簿通过现有原生附件/产物能力交付；按原版要求仅展示用户需要的结果，不把构建器、预览或未解析标记当成交付。
- 原版 Google Sheets 专属插件路径和 Excel Live Control 不由本 Skill 预置。需要 Google Sheets 时先确认当前实际连接与导入能力；未连接或无法导入就说明原生 Sheets 交付尚未完成，不声称本地 XLSX 已成为在线表格，也不自动发送、授权或安装 Codex 插件。

以下为原字节保留的上游 Skill 内容。上述说明只适配当前宿主及原版已有的备用路径，不降低质量要求。
