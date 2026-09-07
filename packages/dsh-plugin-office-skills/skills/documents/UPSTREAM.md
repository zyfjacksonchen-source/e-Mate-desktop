# Word 来源与运行边界

本目录为 e-Mate 的 TypeScript Word 工作流说明，使用已固定的 MIT 开源库 [dolanmiu/docx](https://github.com/dolanmiu/docx) 9.7.1，以及项目已有 JSZip / XML 依赖。没有引入 Hermes Agent、python-docx 或新的 Node 运行时。

Skill 与宿主适配由 e-Mate 维护；不是声称上游提供了同名 Skill。上游库许可随原有依赖打包流程保留。原 Python 方案的源码和测试证据保留在 Git 历史与私有验收目录，当前包不包含这些脚本。

新建、模板填充、定向文字替换由既有 office_write 执行。读取沿用 office_read。完整批注/修订编辑与 Word 排版渲染不在当前三个操作内，相关需求必须另行闭合，不能据此宣称完成整体验收。
