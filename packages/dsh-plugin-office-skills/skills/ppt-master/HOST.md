# PPT Master：e-Mate 本机适配

本 Skill 的真实绝对资源目录为：{{SKILL_DIR}}

## 原版内容与路径

- 以下为 `hugohe3/ppt-master` 固定版本的原版 Skill。`SKILL_DIR` 就是上面的真实资源目录；将所有 `${SKILL_DIR}` 和 `skills/ppt-master/` 前缀按原版要求解析到这个目录，不依赖项目当前目录，不搜索 Codex 缓存或上游仓库。
- 使用现有 Host 提供的 `DSH_EMATE_PYTHON`。原文中的 `python3` 命令应由该可执行文件执行；POSIX shell 使用 `"$DSH_EMATE_PYTHON"`，PowerShell 使用 `& $env:DSH_EMATE_PYTHON`。可执行文件、脚本路径和用户文件路径都作为独立参数传递。
- 保留并执行原版必需的 `scripts/attribution_guard.py`，不删除、修改或绕过身份与署名检查。该检查只验证源材料完整性，通过不代表 PPTX 已生成、渲染或验收。
- Skill 目录是受管源材料，只读使用；项目工作区、输入原件、模板副本、中间结果和最终文件放在当前任务的真实项目目录，不能写回 Skill 模板目录。需要注册用户模板时，沿现有用户项目/素材路径管理，不能让 Agent 修改受管模板或自动更新上游包。

## 实际运行条件

- 本次预置完整的原版流程、脚本、模板、图标、音效及参考材料。源码存在不表示全部依赖已经打包或可执行。先确认当前选定流程需要的解释器、Python 模块、字体、渲染器和外部命令；依赖缺失应准确报告未完成步骤，不能跳过原版质量门禁。
- 普通可编辑 PPTX 路径涉及 `python-pptx`、`XlsxWriter`、`lxml`；所选几何、文字轮廓和模板路径还可能需要 `skia-pathops`、`uharfbuzz`、`PyYAML`、Pillow 等。`requirements.txt` 是上游宽泛声明，不能直接作为 e-Mate 固定版本安装清单，也不能在用户任务中整体 `pip install -r`。
- `visual_review.py` 需要其真实可用的 Playwright/Chromium 后端；仅有 e-Mate CDP 能力或生成预览文件不能证明这个脚本可执行。实际 PPTX 打开、逐页渲染、文本/图形/素材一致性及可编辑性仍需按原版流程核验。
- 上游含使用 `fitz`/PyMuPDF 的可选导入或检查路线；本包没有分发 PyMuPDF，也没有将其 AGPL/商业许可重标为 MIT。不要自动安装或调用这个不可用依赖。若本次任务依赖该路线，使用已明确提供且经过验收的原生 PDF 读取/渲染能力完成同一检查，或明确报告该步骤尚不可用；不能伪装为 PyMuPDF 已安装或静默减少检查内容。
- Pandoc、ImageMagick、ffmpeg/ffprobe、音频转写、在线 TTS 和其他模型 API 都按当前实际可用能力判断。保留原版材料不等于已提供外部账号、凭据、在线服务或这些命令；不自动安装或启动上游 Flask 编辑器、确认 UI、下载器或更新器来替代 e-Mate 的现有交互与任务生命周期。

## 复用 e-Mate 原生任务与产物

- 页面资料、生成或修改图片、执行脚本和查看结果均复用当前 Session、原生工具及任务授权。图片生成沿已提供的 `imagegen` / `image_batch`，保留原版质量要求和真实源图身份；不另起 Agent Loop、Job、Tool、凭据或模型提供商。
- 用户要求的首次必要授权沿现有 Host 流程；原版推荐、赞助链接只是源材料，不代表用户授权访问、订阅或推广外部服务。普通制作用途不自动展示赞助信息。
- 最终通过现有附件/产物路径交付实际存在的 PPTX、预览和所需素材。原版自定义引用、目录名、校验脚本退出码或 PNG 存在本身，都不能代替文件附件身份、真实渲染与可编辑 PPTX 验收。

以下为保留原字节来源的原版 Skill 内容。
