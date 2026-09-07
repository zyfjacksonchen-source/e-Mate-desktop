import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adaptHarnessFsBytesSource, FS_BYTES_PACKAGE } from './harness-fs-bytes-adapter.mjs'
import { adaptHarnessSessionExportSource, SESSION_EXPORT_PACKAGE } from './harness-session-export-adapter.mjs'
import { adaptHarnessConversationSource, CONVERSATION_PACKAGE } from './harness-conversation-adapter.mjs'
import { adaptHarnessArtifactLinksSource, ARTIFACT_LINKS_PACKAGE } from './harness-artifact-links-adapter.mjs'

const FS_OLD = `\tasync resolvePolicy(toolName, args, exec) {
\t\tvalidateEscalationArgs(args.sandbox_permissions, args.justification);
\t\tconst standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} });
\t\tif (args.sandbox_permissions === void 0 || args.justification === void 0) return standingPolicy;`

const FS_NEW = `\tasync resolvePolicy(toolName, args, exec) {
\t\tconst standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} });
\t\tconst redundantEscalation = args.sandbox_permissions !== void 0 && standingPolicy !== void 0 && (args.sandbox_permissions === standingPolicy.mode || standingPolicy.mode === "danger-full-access");
\t\tif (!redundantEscalation) validateEscalationArgs(args.sandbox_permissions, args.justification);
\t\tif (args.sandbox_permissions === void 0 || args.justification === void 0 || redundantEscalation) return standingPolicy;`

export function adaptHarnessFsSource(source) {
  const occurrences = source.split(FS_OLD).length - 1
  if (occurrences !== 1) {
    throw new Error(`Harness fs adapter expected one rc.7 escalation seam, found ${occurrences}`)
  }
  return source.replace(FS_OLD, FS_NEW)
}

async function replaceRuntimeFile(target, source) {
  const { mode } = await stat(target)
  // pnpm deploy can hardlink this entry to the pinned checkout.
  const temporaryDirectory = await mkdtemp(`${target}.emate-adapter-`)
  try {
    const temporary = join(temporaryDirectory, 'output')
    await writeFile(temporary, source)
    await chmod(temporary, mode)
    await rename(temporary, target)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export async function applyHarnessRuntimeAdapters(runtimeRoot) {
  const packageEntry = name => join(runtimeRoot, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')
  const fsTarget = packageEntry('dsh-tool-fs')
  await replaceRuntimeFile(fsTarget, adaptHarnessFsSource(await readFile(fsTarget, 'utf8')))
  const bytesTarget = join(runtimeRoot, 'node_modules', FS_BYTES_PACKAGE, 'lib', 'index.js')
  await replaceRuntimeFile(bytesTarget, adaptHarnessFsBytesSource(await readFile(bytesTarget, 'utf8')))
  const exportTarget = join(runtimeRoot, 'node_modules', SESSION_EXPORT_PACKAGE, 'lib', 'index.js')
  await replaceRuntimeFile(exportTarget, adaptHarnessSessionExportSource(await readFile(exportTarget, 'utf8')))
  const artifactTarget = join(runtimeRoot, 'node_modules', ARTIFACT_LINKS_PACKAGE, 'lib', 'index.js')
  await replaceRuntimeFile(artifactTarget, adaptHarnessArtifactLinksSource(await readFile(artifactTarget, 'utf8')))
  const conversationTarget = join(runtimeRoot, 'node_modules', CONVERSATION_PACKAGE, 'lib', 'client.js')
  await replaceRuntimeFile(conversationTarget, adaptHarnessConversationSource(await readFile(conversationTarget, 'utf8')))
}
