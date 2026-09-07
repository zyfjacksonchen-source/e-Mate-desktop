---
name: documents
description: 创建精美中文 Word 文档，填充已有模板，或保留图片与样式修改文字。
metadata:
  eMateCapability: office
  format: docx
  adapter: docx-typescript
  state: ready
---

# Word 文档

通过 e-Mate 内置 `office_write` / `office_read` 创建和修改 `.docx`。执行由随包 TypeScript 实现和固定 `docx` 库完成，无需用户安装 Python、Office 或 npm 包。

## 选择操作

- 新建报告、方案、信函：先读 `references/chinese-design.md`，再用 `references/tool-input.md` 中的 `create` 输入。保留用户指定的结构、品牌与字体。
- 用户已有含 `{{占位符}}` 的 Word 模板：用 `template` 填充，沿用原模板样式，不把文档抽成纯文本后重建。
- 修改已有文档中的文字：用 `replace`，检查准确目标及命中数量；图片、字段和未修改的格式应保留。跨受保护结构的修改可能明确失败，此时不能改用整篇重建并宣称无损。
- 读取文字：用 `office_read`。它返回内容提取结果，不代表读取了全部样式、批注或修订。

所有操作写入新文件并返回真实 `relative_path`。通过现有附件流程交付该文件；不要猜测路径或编造下载链接。

## 检查交付

生成后重新读取结果，核对正文、数字、标题和表格；修改时检查原件仍保留，目标改动正确。实际版式验收需要渲染或在 Word 中查看每页，检查缺字、裁切、跨页表格和空白页；结构检查不能代替视觉检查。尚无渲染回执时，明确尚未完成分页和视觉验收。

旧式 `.doc`、任意复杂结构编辑、完整批注/修订管理和与 Word 一致的 PDF 转换不由当前三个操作提供。遇到这些需求保留原件并准确报告缺项，不声称已完成。
