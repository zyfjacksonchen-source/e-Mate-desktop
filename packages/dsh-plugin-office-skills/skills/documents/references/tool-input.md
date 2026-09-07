# Word 工具输入

统一调用 `office_write`，顶层 `{ "format": "docx", "filename": "报告.docx", "document": { ... } }`。文件名必须以 `.docx` 结尾；所有输入路径相对于当前项目工作区。输出不会覆盖现有文件。

## 新建

```json
{"operation":"create","spec":{"title":"项目进展报告","subtitle":"2026 年 9 月","header":"项目简报","footer":"内部资料","accent":"214E70","blocks":[{"type":"heading","level":1,"text":"关键结论"},{"type":"paragraph","runs":[{"text":"已完成","bold":true},{"text":"本阶段交付。"}]},{"type":"table","headers":["事项","负责人","状态"],"rows":[["验收","张三","进行中"]]}]}}
```

`spec` 可用字段：`title`、`subtitle`、`header`、`footer`、`font`、`accent`、`blocks`。`accent` 是不带井号的六位十六进制颜色。默认 A4 与商务文档样式。

块类型：
- `heading`：`text` 和可选 `level`（1、2、3）。
- `paragraph`：`text` 或 `runs` 二选一；run 有 `text`、可选 `bold`、`italic`。
- `table`：`headers` 为字符串数组，`rows` 为相同列数的字符串二维数组。
- `image`：`path` 为现有工作区 PNG/JPEG 路径，`width`/`height` 为正像素尺寸，可选 `caption`。不要传 base64 或 `data`；宿主读取真实图片。
- `page-break`：显式分页；不要用连续空段落制造分页。

## 填充模板

```json
{"operation":"template","source_path":"templates/合同.docx","values":{"客户名称":"示例公司","日期":"2026-09-07"}}
```

模板中使用 `{{客户名称}}` 等占位符，values 的键不含花括号，值为字符串。未定义或未找到的占位符不能被当作已成功填充，交付前核对完整性。

## 定向文字替换

```json
{"operation":"replace","source_path":"资料/报告.docx","replacements":[{"find":"旧项目名称","replace":"新项目名称"}]}
```

按原始内容进行匹配，不重复扫描刚插入的文字。先核对准确原文；不能匹配时不要猜测一个近似字符串后修改。保留输入文件，通过新输出路径交付。
