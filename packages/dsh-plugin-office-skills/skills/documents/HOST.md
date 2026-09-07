# e-Mate Word 运行说明

Skill 资源目录：{{SKILL_DIR}}
脚本和参考文件的相对路径均从上述目录解析。
此版本已替换文档 Skill 源码；随包 Python 依赖和渲染环境仍待接通验证。
执行前检查真实运行环境中的 python-docx 和 lxml；不可将 Skill 的存在当作依赖已安装。
不得转用其他工具生成简化文档并宣称完成此 Skill 的排版、修订或渲染验收。


原生 shell 环境变量 `DSH_EMATE_PYTHON` 指向随包解释器。macOS 使用 `"$DSH_EMATE_PYTHON"`，Windows PowerShell 使用 `& $env:DSH_EMATE_PYTHON`，后接带引号的脚本绝对路径和参数。不要用系统 Python 或猜测安装目录。
