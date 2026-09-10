# 2.0.11 → 2.0.18 修复账（回归防护验收依据）

依据用户验收标准：**2.0.11 之后修过的所有 bug，不得在 2.0.18 以相同或不同形式再次出现**。

范围：`6a7f4b9d59a1..3cc4be844607`（2.0.11 已接受源 → 2.0.18 基线）。

| 项 | 数量 |
|---|---|
| 范围内提交总数 | 411 |
| 其中 fix 类提交 | 236 |
| **自带测试守卫的修复** | **218** |
| 修复但未带测试 | 18 |
| 去重后的守卫测试文件 | **151** |

## 判定方法

修复提交自带的测试就是防回归守卫。因此验收 = **在新内核上跑通这些守卫测试全集**，
任何一条失败即判定该 bug 复现（无论形式是否相同）。

对未带测试的 18 条，必须逐条补一个定向检查；这是本账的待办缺口，不得默认放过。

## 修复按区域分布

| 区域 | 涉及修复数 |
|---|---|
| `other` | 81 |
| `scripts` | 59 |
| `desktop` | 55 |
| `shell` | 42 |
| `profile-core` | 35 |
| `enterprise` | 29 |
| `plugin:knowledge` | 21 |
| `plugin:office-skills` | 14 |
| `plugin:mcp-manage` | 11 |
| `plugin:canvas` | 11 |
| `plugin:skill-hub` | 10 |
| `plugin:vision-toolkit` | 9 |
| `plugin:glass-composer` | 6 |
| `plugin:pet` | 6 |
| `plugin:computer-use` | 5 |
| `plugin:file-import` | 5 |
| `plugin:genui` | 5 |
| `plugin:tool-search` | 5 |
| `plugin:cdp` | 4 |
| `plugin:find-skill` | 4 |
| `plugin:memory-evolve` | 4 |
| `plugin:better-sidebar` | 3 |
| `plugin:schedules` | 3 |
| `plugin:tidychat` | 3 |
| `harness-submodule` | 1 |

## 守卫测试文件全集（151）

这 151 个文件是回归验收的最小必跑集：

- `desktop/e-mate-desktop/scripts/candidate-promotion-worker.test.mjs`
- `desktop/e-mate-desktop/scripts/candidate-update-worker.test.mjs`
- `desktop/e-mate-desktop/scripts/prepare-calc-runtime.spec.mjs`
- `desktop/e-mate-desktop/scripts/prepare-python-runtime.spec.mjs`
- `desktop/e-mate-desktop/scripts/verify-update-acceptance.test.mjs`
- `desktop/e-mate-desktop/tests/agent-update.spec.ts`
- `desktop/e-mate-desktop/tests/client-environment.spec.ts`
- `desktop/e-mate-desktop/tests/desktop-release-manifest.spec.ts`
- `desktop/e-mate-desktop/tests/desktop-runtime-environment.spec.ts`
- `desktop/e-mate-desktop/tests/e-mate-profile-win.spec.ts`
- `desktop/e-mate-desktop/tests/e-mate-profile.spec.ts`
- `desktop/e-mate-desktop/tests/electron-runtime.spec.ts`
- `desktop/e-mate-desktop/tests/file-viewer.spec.ts`
- `desktop/e-mate-desktop/tests/mac-update-installer.spec.ts`
- `desktop/e-mate-desktop/tests/package.spec.ts`
- `desktop/e-mate-desktop/tests/profile-release.spec.ts`
- `desktop/e-mate-desktop/tests/relaunch-arguments.spec.ts`
- `desktop/e-mate-desktop/tests/shutdown.spec.ts`
- `desktop/e-mate-desktop/tests/update-checker.spec.ts`
- `desktop/e-mate-desktop/tests/update-download.spec.ts`
- `desktop/e-mate-desktop/tests/updates.spec.ts`
- `desktop/e-mate-desktop/tests/verify-packaged-runtime.spec.ts`
- `desktop/e-mate-desktop/tests/visualize.spec.ts`
- `desktop/e-mate-desktop/tests/window-options.spec.ts`
- `desktop/e-mate-desktop/tests/windows-update-installer.spec.ts`
- `desktop/e-mate-desktop/tests/windows-update-transaction.spec.ts`
- `enterprise/apps/admin/tests/api.test.ts`
- `enterprise/apps/analytics-api/tests/admin-management.test.ts`
- `enterprise/apps/analytics-api/tests/knowledge-client.test.ts`
- `enterprise/apps/analytics-api/tests/postgres-integration.test.ts`
- `enterprise/apps/analytics-api/tests/production.test.ts`
- `enterprise/apps/auth-gateway/tests/crypto.test.ts`
- `enterprise/apps/auth-gateway/tests/identity-ownership.test.ts`
- `enterprise/apps/auth-gateway/tests/postgres-integration.test.ts`
- `enterprise/apps/auth-gateway/tests/production.test.ts`
- `enterprise/apps/model-gateway/tests/model-gateway-contract.test.ts`
- `enterprise/apps/model-gateway/tests/model-smoke.test.ts`
- `enterprise/apps/model-gateway/tests/postgres-integration.test.ts`
- `enterprise/apps/model-gateway/tests/postgres-usage-store.test.ts`
- `enterprise/apps/model-gateway/tests/production-configuration.test.ts`
- `enterprise/apps/share-service/tests/service.test.ts`
- `enterprise/apps/share-worker/tests/index.test.mjs`
- `enterprise/apps/skill-hub-service/tests/service.test.ts`
- `enterprise/apps/skill-hub-worker/tests/index.test.mjs`
- `enterprise/packages/admin-contract/tests/admin-contract.test.ts`
- `packages/dsh-plugin-canvas/test/browser-entry.tsx`
- `packages/dsh-plugin-canvas/test/browser.test.mjs`
- `packages/dsh-plugin-canvas/test/editor.client.spec.tsx`
- `packages/dsh-plugin-canvas/test/lifecycle.client.spec.tsx`
- `packages/dsh-plugin-canvas/test/project.test.mjs`
- `packages/dsh-plugin-canvas/test/rpc.test.mjs`
- `packages/dsh-plugin-cdp/test/contract.test.mjs`
- `packages/dsh-plugin-computer-use/test/contract.test.mjs`
- `packages/dsh-plugin-computer-use/test/windows-source.test.mjs`
- `packages/dsh-plugin-file-import/test/client-flow.client.spec.tsx`
- `packages/dsh-plugin-find-skill/test/contract.test.mjs`
- `packages/dsh-plugin-genui/test/client-bundle.test.mjs`
- `packages/dsh-plugin-genui/test/package.test.mjs`
- `packages/dsh-plugin-glass-composer/test/contracts.test.mjs`
- `packages/dsh-plugin-knowledge/test/agent-tools.test.mjs`
- `packages/dsh-plugin-knowledge/test/host.test.mjs`
- `packages/dsh-plugin-knowledge/test/imports.client.spec.tsx`
- `packages/dsh-plugin-knowledge/test/page.client.spec.tsx`
- `packages/dsh-plugin-knowledge/test/recovery.test.mjs`
- `packages/dsh-plugin-knowledge/test/ui-operations.test.mjs`
- `packages/dsh-plugin-knowledge/test/ui-read.test.mjs`
- `packages/dsh-plugin-knowledge/test/workflow.test.mjs`
- `packages/dsh-plugin-mcp-manage/test/contract.test.mjs`
- `packages/dsh-plugin-memory-evolve/test/store.test.mjs`
- `packages/dsh-plugin-office-skills/skills/documents/tests/test_emate_docx.py`
- `packages/dsh-plugin-office-skills/skills/ppt-master/scripts/tests/test_native_export_guards.py`
- `packages/dsh-plugin-office-skills/test/calc-runtime.test.mjs`
- `packages/dsh-plugin-office-skills/test/fixtures/pdf-empty-glyf.pdf`
- `packages/dsh-plugin-office-skills/test/package.test.mjs`
- `packages/dsh-plugin-office-skills/test/preview.client.spec.tsx`
- `packages/dsh-plugin-office-skills/test/preview.test.mjs`
- `packages/dsh-plugin-pet/test/contracts.test.mjs`
- `packages/dsh-plugin-pet/test/native-projection.test.mjs`
- `packages/dsh-plugin-pet/test/pet.client.spec.tsx`
- `packages/dsh-plugin-pet/test/resources.test.mjs`
- `packages/dsh-plugin-skill-hub/test/capabilities-layout.test.mjs`
- `packages/dsh-plugin-skill-hub/test/capabilities.client.spec.tsx`
- `packages/dsh-plugin-skill-hub/test/skill-hub.test.mjs`
- `packages/dsh-plugin-tidychat/test/folding.test.mjs`
- `packages/dsh-plugin-tidychat/test/navigation.client.spec.tsx`
- `packages/dsh-plugin-tool-search/test/tool-search.test.mjs`
- `packages/dsh-plugin-vision-toolkit/test/attachment-source.test.mjs`
- `packages/dsh-plugin-vision-toolkit/test/contract.test.mjs`
- `packages/dsh/profile/plugins/emate-shell/tests/account-home.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/activity-fold.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/chat-context.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/chat-fidelity.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/composer-205.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/composer-mentions.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/connection-status.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/enterprise-model-recovery.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/header-controls.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/identity-settings-fidelity.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/image-batch-client.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/image-batch-progress.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/image-gallery.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/native-tool-image-output.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/quick-templates.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/session-share.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/sidebar-home-fidelity.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/sidebar-settings-route.client.spec.tsx`
- `packages/dsh/profile/plugins/emate-shell/tests/task-details.client.spec.tsx`
- `packages/dsh/test/e-mate.test.mjs`
- `packages/dsh/test/http-response.test.mjs`
- `packages/dsh/test/identity-lifecycle.test.mjs`
- `packages/dsh/test/image-batch-recovery.test.mjs`
- `packages/dsh/test/image-batch-worker-stress.test.mjs`
- `packages/dsh/test/image-model-policy.test.mjs`
- `packages/dsh/test/native-image-task-runner.test.mjs`
- `packages/dsh/test/request-size.test.mjs`
- `packages/dsh/test/share.test.mjs`
- `scripts/change-impact.test.mjs`
- `scripts/component-release.test.mjs`
- `scripts/desktop-admission.test.mjs`
- `scripts/harness-artifact-links-adapter.test.mjs`
- `scripts/harness-conversation-adapter.test.mjs`
- `scripts/harness-fs-bytes-adapter.test.mjs`
- `scripts/harness-provenance.test.mjs`
- `scripts/harness-runtime-adapters.test.mjs`
- `scripts/harness-session-export-adapter.test.mjs`
- `scripts/local-flow.test.mjs`
- `scripts/performance-acceptance-probe.test.mjs`
- `scripts/performance-acceptance.test.mjs`
- `scripts/performance-parity.test.mjs`
- `scripts/profile-release.test.mjs`
- `scripts/release-coordinator.test.mjs`
- `scripts/release.test.mjs`
- `scripts/verify-desktop-update-reader.test.mjs`
- `tests/performance/image-batch/RUNNING.md`
- `tests/performance/image-batch/mixed-admission.mjs`
- `tests/performance/image-batch/project-release-evidence.mjs`
- `tests/performance/image-batch/real-provider-benchmark.mjs`
- `tests/performance/image-batch/real-provider-benchmark.test.mjs`
- `tests/performance/image-batch/release-evidence-protocol.mjs`
- `tests/performance/image-batch/release-evidence-protocol.test.mjs`
- `tests/performance/image-batch/release-identity.mjs`
- `tests/performance/image-batch/stress.test.mjs`
- `tests/performance/image-single/benchmark.mjs`
- `tests/performance/image-single/contract.test.mjs`
- `tests/performance/image-single/project-evidence.mjs`
- `tests/performance/image-single/protocol.mjs`
- `tests/performance/image-single/worker.mjs`
- `tests/quality/image-batch/noninferiority-protocol.mjs`
- `tests/quality/image-batch/noninferiority.test.mjs`
- `tests/quality/image-batch/real-study.mjs`
- `tests/quality/image-batch/real-study.test.mjs`
