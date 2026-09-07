# PDF：e-Mate 本机适配

本 Skill 的真实绝对资源目录为：{{SKILL_DIR}}
以下原版中的相对脚本、图标等路径都从该目录解析，不从当前项目猜测。

## 运行环境

- 使用现有 Host 提供的 `DSH_EMATE_PYTHON` 所指的 Python。POSIX shell 调用 `"$DSH_EMATE_PYTHON"`；PowerShell 调用 `& $env:DSH_EMATE_PYTHON`。路径必须作为单个参数，不拼接未转义的用户文件名。
- 先检查变量所指可执行文件和本次操作所需依赖是否真实可用。PDF 创建需要 `reportlab`，读取/表单需要对应的 `pypdf` 或 `pdfplumber`，页面渲染需要真实 `pdftoppm`/`pdfinfo` 或 Host 已明确提供并经过验收的等效渲染路径。
- 本次仅预置原版 Skill 材料；不代表这些 Python 包、渲染命令已接通或验收。不可把仅有 Python、原 Office Tools 或文本提取当作完整 PDF 运行环境。缺失时准确说明具体依赖和未完成步骤，不跳过原版表单一致性和最终视觉验收。
- 不使用 Codex 私有缓存路径，不复制私有运行库，不提供空操作 renderer。需要安装依赖时沿用 e-Mate 的宿主管理流程与现有授权，不让模型在受管 Skill/运行库目录中自行改环境。

## 标记、路径和交付

- 中文正文可使用本 Skill 内的 `assets/noto-sans-sc/NotoSansSC-Regular.ttf`，通过 ReportLab 的 `pdfmetrics.registerFont(TTFont('NotoSansSC', 字体绝对路径))` 注册，再把段落、表格和画布文字的字体设为 `NotoSansSC`。这是固定 400 字重的静态 TTF，客户端无需字体转换工具，也无需系统预装该字体。
- 字体并不覆盖所有 Unicode 字符。生成前用已注册字体的 `face.charToGlyph` 核对实际文字（排除换行等控制字符）；缺字时使用已授权且覆盖对应字符的字体，不能把方框或丢字当成完成。最终仍须检查嵌入、文字提取和真实逐页渲染。字体来源、修改和 OFL 许可保存在同目录。

- 原版 `container_tools/mark_artifact_operation_started.mjs` 使用现有原生 Node 执行，路径为该资源目录下的完整路径。它仅验证 `create/edit`、预期数量和 `pdf` 参数，成功退出不表示已生成、保存、渲染或登记任何产物。
- 原版 `tmp/pdfs/` 和 `output/pdf/` 均相对于当前任务工作区。保留输入原件，实际产物用新的文件名保存；不要写进此只读 Skill 资源目录。
- e-Mate 不消费 Codex 专用 `:codex-file-citation{...}` 标记。将原版要求的最终文件引用通过当前 e-Mate 原生附件/产物路径交付，引用实际存在的 PDF；不要把未解析标记、临时 PNG 或标记脚本的退出码当成已交付文件。
- 保留以下原版内容要求的逐页视觉检查，以及交互表单字段树、Widget、值、外观的真实重开校验。只有事实检查完成才能说明通过。

## 随包逐页渲染入口

`scripts/render_pdf.py` 使用公开的 pypdfium2/PDFium 实际渲染 PDF，作为页面视觉检查的等效路径。具体调用见 `references/rendering.md`。它需要真实可导入的 pypdfium2 与 Pillow；源码存在不代表依赖已打包。只接受新的输出目录，成功回执列出每页 PNG、尺寸与页数；失败不得报告渲染完成。生成后用现有看图能力逐页查看 PNG，并继续检查原 PDF 的表单和文本，不能仅凭 PNG 存在宣称视觉合格。

以下为保留原字节来源的原版 Skill 内容。
