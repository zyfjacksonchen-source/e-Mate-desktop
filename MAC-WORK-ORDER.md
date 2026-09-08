# e-Mate 2.0.18 Windows Calc 交接工单

本次用户明确要求用 Markdown 文件传递交接和回执。此分支仅用于这次交接，不是产品或发布分支。

## 当前源码

- 产品集成：feat/2.0.18/integration，7b9e64a8646cc9386b78e02cca7ac44097c38408。
- Calc 草稿：fix/2.0.18/calc-native-handoff，49475923。草稿基于704db5ce，尚未合入产品。
- 草稿仅改 prepare-calc-runtime.mjs、现有 spec、calc-runtime/manifest.json。
- 本地6项测试通过；现有Mac arm64和x64 Calc缓存各18538条目全量校验通过。这不代表Windows通过。

## Windows 执行要求

在现有 Codex Remote LAPTOP-ADQ973JN 登录用户环境执行；不用SSH，不修改旧脏树或全局网络。先读取现有Git进程状态，保留失败目录，仅对确认无进展的本次克隆执行有界恢复。

获取Calc草稿，优先HTTP/1.1及已验证本机代理的单次Git参数、depth 1和blob过滤。该交接分支只有Markdown，可独立浅克隆，避免产品大文件阻塞回执传递。

实际运行现有prepare-calc-runtime.spec.mjs，然后使用已有官方MSI执行 prepare-calc-runtime.mjs --target win32-x64 --archive-dir C:\eMateBuild\EM218-native-calc-20260908，再以--verify-root校验实际输出目录。记录准确cwd、Node版本、每条命令、开始结束UTC、退出码和原始输出摘要。

核实 readmes/readme_en-US.txt 存在、soffice.exe为AMD64和26.8.0.3、19418文件及1596517458逻辑字节是否含行政MSI且更换staging目录后稳定。若失败保留原始日志，在独立fix/2.0.18/windows-calc-runtime分支仅修正上述3文件并推送。

## 已读取的原生事实

- MSI 374906880 bytes，SHA256 4aa6c6e1895f4055104effcb556bd3362d20c6ad707c149543304f395ef9db95。
- msiexec /a退出0，实际用户LAPTOP-ADQ973JN\user。
- 原提取目录C:\eMateBuild\EM218-native-calc-20260908\staging。
- 原始证据：extraction-result.json、extraction-summary.json、file-manifest-sha256.json、soffice-pe-evidence.json、license-notice-readme-evidence.json及msiexec-admin-extract.log。

## 回传

将真实回执写入本分支根目录 HANDOFF-WINDOWS-CALC.md，然后git提交推送到同一分支 handoff/2.0.18/windows-calc。保留本工单。只提交这次去除凭据和个人信息的Markdown，不提交MSI、缓存、安装包或其他work文件。不要输出凭据、令牌或完整环境变量。

回执应含：源码SHA、执行身份、真实命令/退出码、验证结果、日志路径、阻塞及下一步。未执行必须写OPEN，不得写PASS。若推送失败，先保留本地MD并注明位置。

本工单不授权构建安装包、安装、发布；主任务整合和核验后统一下达。产品发布总授权仍有效，但不能跳过双端原生及安装验收。
