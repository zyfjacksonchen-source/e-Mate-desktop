# PDF 逐页渲染

本地辅助脚本调用公开 **pypdfium2 / PDFium** 及 Pillow，将真实 PDF 渲染成逐页 PNG；不是文本提取或替代版面。沿用 e-Mate 已有 Python 入口，不下载运行时，也不依赖 PyMuPDF。

macOS 原生 bash：

```bash
"$DSH_EMATE_PYTHON" "/absolute/skill/pdf/scripts/render_pdf.py" "/workspace/report.pdf" "/workspace/report-review-new" --dpi 144
```

Windows 原生 PowerShell：

```powershell
& $env:DSH_EMATE_PYTHON 'C:\skill\pdf\scripts\render_pdf.py' 'C:\workspace\report.pdf' 'C:\workspace\report-review-new' --dpi 144
```

脚本路径由实际 Skill 目录解析。输出父目录必须存在，最终输出目录必须全新；已有目录（即便为空）也拒绝，绝不覆盖。全部页面成功后，stdout 和输出目录中的 `render.json` 返回 `ok:true`、页数、DPI、每页实际像素尺寸与绝对路径；失败返回非零退出码及 stderr `ok:false`，不发布成功回执。加密 PDF 缺少解锁条件会失败，脚本不接受聊天明文密码或猜测密码。

默认 144 DPI，可用范围 36–300；输入最多 64 MiB、1–200 页、单页最多 1600 万像素、全部最多 1 亿像素。逐页顺序处理并及时关闭 PIL 图像、PDFium 位图、页面和文档，避免并发堆积。像素限制约束栅格分配，不等于整个 PDFium 进程的严格内存上限；沿用现有宿主进程超时、取消及沙箱边界。

完成后打开每张 PNG 检查缺字、裁切、表格溢出与分页。PNG 创建成功不代表视觉验收通过；本机能 import pypdfium2 也不能证明安装包已携带依赖。缺失依赖明确失败，由开发时的既有打包流程处理，不在用户任务中临时安装。

依据：[pypdfium2 官方 Python API](https://pypdfium2.readthedocs.io/en/stable/python_api.html)。使用 `PdfDocument`、`init_forms()`、`get_size()`、`render(scale=dpi/72)`、`PdfBitmap.to_pil()`；关闭图像后再关闭其共享内存位图。PDFium 不支持多线程并发调用，本脚本只顺序处理。
