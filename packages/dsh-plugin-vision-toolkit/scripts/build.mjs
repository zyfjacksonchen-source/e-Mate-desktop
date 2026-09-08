import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, '../../upstream/plugins/dsh-vision-toolkit')
const staged = resolve(root, '.build/upstream-lib')

function replaceExactlyOnce(value, before, after, label) {
  const count = value.split(before).length - 1
  if (count !== 1) throw new Error(`pinned dsh-vision-toolkit ${label} contract changed`)
  return value.replace(before, after)
}

function replaceSection(value, start, end, replacement, label) {
  const from = value.indexOf(start)
  const to = from < 0 ? -1 : value.indexOf(end, from + start.length)
  if (from < 0 || to < 0 || value.indexOf(start, from + start.length) >= 0) {
    throw new Error(`pinned dsh-vision-toolkit ${label} contract changed`)
  }
  return value.slice(0, from) + replacement + value.slice(to)
}

async function readPinnedText(path) {
  const value = await readFile(path, 'utf8')
  const normalized = value.replaceAll('\r\n', '\n')
  if (normalized.includes('\r')) throw new Error(`pinned dsh-vision-toolkit file has unsupported line endings: ${path}`)
  return normalized
}

await rm(resolve(root, '.build'), { recursive: true, force: true })
await mkdir(staged, { recursive: true })
await cp(resolve(source, 'lib'), staged, { recursive: true })
await cp(resolve(source, 'package.json'), resolve(root, '.build/package.json'))

const upstreamIndex = resolve(staged, 'index.js')
let index = await readPinnedText(upstreamIndex)
const applyBefore = 'export async function apply(ctx, config = {}) {'
const applyAfter = `export async function apply(ctx, config = {}, options = {}) {
    let managedReady = options.managed !== true;`
const validateBefore = 'validate: (value) => { resolveConfig(value); },'
const validateAfter = 'validate: (value) => { const resolved = resolveConfig(value); if (managedReady) options.validateConfig?.(resolved); },'
const backendBefore = 'const backend = new VisionToolkitWebBackend(ctx, manager, artifacts, ensureOperational);'
const backendAfter = 'const backend = new VisionToolkitWebBackend(ctx, manager, artifacts, ensureOperational, options.managed === true);'
const operationalBefore = `    let operationalDisposers;
    const ensureOperational = () => {`
const operationalAfter = `    let operationalDisposers;
    const deactivateOperational = () => {
        if (operationalDisposers === undefined)
            return;
        operationalDisposers.exposure();
        operationalDisposers.activationTool();
        operationalDisposers.skill();
        operationalDisposers = undefined;
    };
    const ensureOperational = () => {`
const managerBefore = `    });
    const manager = new VisionToolkitRuntimeManager(ctx);`
const managerAfter = `    });
    if (options.managed === true) {
        await ctx.settings.replace(VISION_TOOLKIT_SETTINGS_NAMESPACE, config);
        managedReady = true;
    }
    const manager = new VisionToolkitRuntimeManager(ctx);
    let runtimePending;
    const prepareRuntime = async () => {
        if (manager.ready)
            return manager.current();
        runtimePending ??= manager.reconfigure(settings.get()).then(() => manager.current()).finally(() => { runtimePending = undefined; });
        return runtimePending;
    };
    const lazyRuntime = new Proxy({}, {
        get(_target, property) {
            return async (...args) => {
                const runtime = await prepareRuntime();
                options.validateConfig?.(runtime.config);
                const member = runtime[property];
                if (typeof member !== 'function')
                    throw new Error(\`dsh-vision-toolkit runtime member \${String(property)} is not callable\`);
                return member.apply(runtime, args);
            };
        },
    });`
if (!index.includes(applyBefore) || !index.includes(validateBefore)
  || !index.includes(backendBefore) || !index.includes(managerBefore) || !index.includes(operationalBefore)) {
  throw new Error('pinned dsh-vision-toolkit apply contract changed')
}
index = index
  .replace("export const name = '@anionex/dsh-vision-toolkit';", "export const name = '@e-mate/dsh-plugin-vision-toolkit';")
  .replace(applyBefore, applyAfter)
  .replace(validateBefore, validateAfter)
  .replace(managerBefore, managerAfter)
  .replace(operationalBefore, operationalAfter)
  .replace(backendBefore, backendAfter)
index = replaceExactlyOnce(
  index,
  `import { PastedImageBackend } from "./paste-images.js";`,
  ``,
  'legacy pasted-image backend import',
)
index = replaceExactlyOnce(
  index,
  `    const disposers = [];`,
  `    const disposers = [];
    const imageInputBridgeDisposer = options.installImageInputBridge?.(lazyRuntime);
    if (imageInputBridgeDisposer !== undefined)
        disposers.push(imageInputBridgeDisposer);`,
  'image request-boundary disposer',
)
index = replaceExactlyOnce(
  index,
  `        if (!manager.ready || operationalDisposers !== undefined)
            return;`,
  `        if (operationalDisposers !== undefined)
            return;`,
  'lazy operational exposure',
)
index = replaceExactlyOnce(
  index,
  `            const info = manager.current().upstreamVersion;
            ctx.logger.info('dsh-vision-toolkit %s ready (upstream %s @ %s, checkout %s)', PLUGIN_VERSION, info.version, info.commit, info.path);`,
  `            if (manager.ready) {
                const info = manager.current().upstreamVersion;
                ctx.logger.info('dsh-vision-toolkit %s ready (upstream %s @ %s, checkout %s)', PLUGIN_VERSION, info.version, info.commit, info.path);
            }
            else {
                ctx.logger.info('dsh-vision-toolkit %s loaded; runtime preparation is deferred until first use', PLUGIN_VERSION);
            }`,
  'lazy readiness logging',
)
index = replaceExactlyOnce(
  index,
  `    try {
        await manager.initialize(settings.get());
        ensureOperational();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error('dsh-vision-toolkit %s: runtime not ready; the vision-tools skill, activation bootstrap, and Agent-scoped visual tools are NOT registered. Settings remain available for repair. %s', PLUGIN_VERSION, message);
    }`,
  `    if (options.managed !== true) {
        try {
            await manager.initialize(settings.get());
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.error('dsh-vision-toolkit %s: runtime not ready; Settings remain available for repair. %s', PLUGIN_VERSION, message);
        }
    }
    ensureOperational();`,
  'managed lazy first use',
)
index = replaceExactlyOnce(
  index,
  `    const pastedImages = new PastedImageBackend(ctx, {
        maxImageBytes: () => manager.status().activeConfig?.maxImageBytes ?? resolveConfig(settings.get()).maxImageBytes,
    });
    installVisionToolkitWeb(ctx, backend, artifacts, pastedImages);`,
  `    installVisionToolkitWeb(ctx, backend, artifacts);`,
  'native attachment first Web surface',
)
index = replaceExactlyOnce(
  index,
  `    disposers.push(settings.watch(async (next) => {
        try {
            await manager.reconfigure(next);
            ensureOperational();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.error('dsh-vision-toolkit: keeping the previous runtime after a refused Settings generation. %s', message);
        }
    }));`,
  `    disposers.push(settings.watch(async (next) => {
        if (options.managed === true) {
            deactivateOperational();
            manager.deactivate();
        }
        try {
            await manager.reconfigure(next);
            if (options.managed === true)
                options.validateConfig?.(next);
            ensureOperational();
        }
        catch (error) {
            if (options.managed === true) {
                deactivateOperational();
                manager.deactivate();
            }
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.error(options.managed === true
                ? 'dsh-vision-toolkit: managed Settings generation refused; runtime remains unavailable. %s'
                : 'dsh-vision-toolkit: keeping the previous runtime after a refused Settings generation. %s', message);
        }
    }));`,
  'managed fail-closed reconfiguration',
)
index = replaceExactlyOnce(
  index,
  `        const exposure = new VisionToolExposure(ctx, () => createVisionTools(() => manager.current(), value => artifacts.presentationMeta(value), lifecycle.signal));`,
  `        const currentRuntime = () => {
            const runtime = manager.current();
            if (options.managed === true)
                options.validateConfig?.(runtime.config);
            return runtime;
        };
        const exposure = new VisionToolExposure(ctx, () => createVisionTools(currentRuntime, value => artifacts.presentationMeta(value), lifecycle.signal, options.assertWriteAllowed, options.resolveGlanceImages));`,
  'managed execution policy validation',
)
index = replaceExactlyOnce(
  index,
  `        lifecycle.abort();
        if (operationalDisposers !== undefined) {
            operationalDisposers.exposure();
            operationalDisposers.activationTool();
            operationalDisposers.skill();
            operationalDisposers = undefined;
        }`,
  `        lifecycle.abort();
        deactivateOperational();`,
  'operational disposal',
)
index = replaceExactlyOnce(
  index,
  `        const currentRuntime = () => {
            const runtime = manager.current();
            if (options.managed === true)
                options.validateConfig?.(runtime.config);
            return runtime;
        };`,
  `        const currentRuntime = () => {
            if (options.managed === true)
                return lazyRuntime;
            return manager.current();
        };`,
  'managed lazy runtime source',
)
index = replaceExactlyOnce(
  index,
  `    disposers.push(settings.watch(async (next) => {
        if (options.managed === true) {
            deactivateOperational();
            manager.deactivate();
        }
        try {
            await manager.reconfigure(next);
            if (options.managed === true)
                options.validateConfig?.(next);
            ensureOperational();
        }
        catch (error) {
            if (options.managed === true) {
                deactivateOperational();
                manager.deactivate();
            }
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.error(options.managed === true
                ? 'dsh-vision-toolkit: managed Settings generation refused; runtime remains unavailable. %s'
                : 'dsh-vision-toolkit: keeping the previous runtime after a refused Settings generation. %s', message);
        }
    }));`,
  `    disposers.push(settings.watch(async (next) => {
        if (options.managed === true) {
            manager.deactivate();
            return;
        }
        try {
            await manager.reconfigure(next);
            ensureOperational();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.error('dsh-vision-toolkit: keeping the previous runtime after a refused Settings generation. %s', message);
        }
    }));`,
  'managed lazy Settings generation',
)
await writeFile(upstreamIndex, index)

const runtimeManagerPath = resolve(staged, 'runtime-manager.js')
let runtimeManager = await readPinnedText(runtimeManagerPath)
runtimeManager = replaceExactlyOnce(
  runtimeManager,
  `    /** Resolve and fully prepare a candidate without changing the active runtime. */`,
  `    /** Fail closed before a managed policy generation is prepared. */
    deactivate() {
        this.reconfigureTicket += 1;
        this.active = undefined;
        this.lastError = undefined;
    }
    /** Resolve and fully prepare a candidate without changing the active runtime. */`,
  'managed runtime deactivation',
)
await writeFile(runtimeManagerPath, runtimeManager)

const configPath = resolve(staged, 'config.js')
let config = await readPinnedText(configPath)
config = replaceExactlyOnce(
  config,
  "protocol: z.union(['openai', 'anthropic']).default('openai'),",
  "protocol: z.union(['openai', 'responses', 'anthropic']).default('openai'),",
  'Responses protocol schema',
)
config = replaceExactlyOnce(
  config,
  "if (protocol !== 'openai' && protocol !== 'anthropic') {",
  "if (protocol !== 'openai' && protocol !== 'responses' && protocol !== 'anthropic') {",
  'Responses protocol validation',
)
config = replaceExactlyOnce(
  config,
  'provider.protocol must be "openai" or "anthropic"',
  'provider.protocol must be "openai", "responses", or "anthropic"',
  'Responses protocol error',
)
await writeFile(configPath, config)

const runtimePath = resolve(staged, 'runtime.js')
let runtime = await readPinnedText(runtimePath)
runtime = replaceExactlyOnce(
  runtime,
  "VISION_API_PROTOCOL: this.config.provider.protocol === 'anthropic' ? 'anthropic' : 'chat_completions',",
  "VISION_API_PROTOCOL: this.config.provider.protocol === 'anthropic' ? 'anthropic' : this.config.provider.protocol === 'responses' ? 'responses' : 'chat_completions',",
  'Responses runtime projection',
)
await writeFile(runtimePath, runtime)

const webPath = resolve(staged, 'web.js')
let web = await readPinnedText(webPath)
web = replaceExactlyOnce(
  web,
  `import { PASTE_IMAGES_ROUTE } from "./paste-images.js";`,
  ``,
  'legacy pasted-image Web import',
)
web = replaceExactlyOnce(
  web,
  `export function installVisionToolkitWeb(ctx, backend, artifacts, pastedImages) {`,
  `export function installVisionToolkitWeb(ctx, backend, artifacts) {`,
  'native attachment first Web signature',
)
web = replaceExactlyOnce(
  web,
  `            const disposePasteImages = webCtx.webServer.register({
                kind: 'exact',
                path: PASTE_IMAGES_ROUTE,
                handler: (req, res) => pastedImages.handle(req, res),
            });
`,
  ``,
  'legacy pasted-image Web route',
)
web = replaceExactlyOnce(
  web,
  `                disposePasteImages();
`,
  ``,
  'legacy pasted-image Web disposer',
)
const webTransforms = [
  [
    `    onRuntimeActivated;
    constructor(ctx, manager, artifacts, onRuntimeActivated) {
        this.ctx = ctx;
        this.manager = manager;
        this.artifacts = artifacts;
        this.onRuntimeActivated = onRuntimeActivated;
    }`,
    `    onRuntimeActivated;
    managed;
    constructor(ctx, manager, artifacts, onRuntimeActivated, managed = false) {
        this.ctx = ctx;
        this.manager = manager;
        this.artifacts = artifacts;
        this.onRuntimeActivated = onRuntimeActivated;
        this.managed = managed;
    }`,
  ],
  ['            writable: this.ctx.settings.writable,', '            writable: this.managed ? false : this.ctx.settings.writable,'],
  ['                writable: credential.writable,', '                writable: this.managed ? false : credential.writable,'],
  [
    `    async save(request) {
        if (!this.ctx.settings.writable)`,
    `    async save(request) {
        if (this.managed)
            throw new Error('Vision Toolkit settings are managed by the enterprise model policy');
        if (!this.ctx.settings.writable)`,
  ],
  [
    `    async saveCredential(request) {
        const descriptor = descriptorOf(this.ctx);`,
    `    async saveCredential(request) {
        if (this.managed)
            throw new Error('Vision Toolkit credentials are managed by the enterprise model policy');
        const descriptor = descriptorOf(this.ctx);`,
  ],
  [
    `        try {
            switch (parsed.action) {`,
    `        if (this.managed && parsed.action !== 'health') {
            requestError(res, 403, 'managed-policy', 'Vision Toolkit settings and credentials are managed by the enterprise model policy');
            return;
        }
        try {
            switch (parsed.action) {`,
  ],
]
for (const [before, after] of webTransforms) {
  if (!web.includes(before)) throw new Error('pinned dsh-vision-toolkit managed Web contract changed')
  web = web.replace(before, after)
}
await writeFile(webPath, web)

const toolsPath = resolve(staged, 'tools.js')
let tools = await readPinnedText(toolsPath)
tools = replaceExactlyOnce(
  tools,
  'export function createVisionTools(source, projectPresentation = presentationIdentity, lifecycleSignal) {',
  'export function createVisionTools(source, projectPresentation = presentationIdentity, lifecycleSignal, assertWriteAllowed, resolveGlanceImages) {',
  'artifact write policy hook',
)
tools = replaceExactlyOnce(
  tools,
  "description: 'One or more image paths; pass comparison images together.'",
  "description: 'One or more workspace image paths or exact current-session sha256 attachment IDs; pass source and result together for comparison.'",
  'glance attachment input description',
)
const requestBefore = `                const request = {
                    images: args.images,
                    ...(args.query === undefined ? {} : { query: args.query }),
                    ...(args.ocr === true ? { ocr: true } : {}),
                    ...(args.region === undefined ? {} : { region: args.region }),
                };`
const requestAfter = `                const query = args.query?.trim();
                const region = args.region?.trim();
                const request = {
                    images: args.images,
                    ...(query ? { query } : {}),
                    ...(args.ocr === true ? { ocr: true } : {}),
                    ...(region ? { region } : {}),
                };`
if (!tools.includes(requestBefore)) throw new Error('pinned dsh-vision-toolkit glance contract changed')
tools = tools.replace(requestBefore, requestAfter)
tools = replaceExactlyOnce(
  tools,
  '                return runtimeFrom(source).glance(request, callOptions(exec, args.timeoutMs, lifecycleSignal));',
  `                const runtime = runtimeFrom(source);
                const options = callOptions(exec, args.timeoutMs, lifecycleSignal);
                return resolveGlanceImages === undefined
                    ? runtime.glance(request, options)
                    : resolveGlanceImages(request.images, exec, images => runtime.glance({ ...request, images }, options));`,
  'glance attachment resolver',
)

function guardTool(sourceText, toolName, conditional = false) {
  const marker = `            name: '${toolName}',`
  const markerAt = sourceText.indexOf(marker)
  if (markerAt < 0 || sourceText.indexOf(marker, markerAt + marker.length) >= 0) {
    throw new Error(`pinned dsh-vision-toolkit ${toolName} contract changed`)
  }
  const nextTool = sourceText.indexOf('        defineTool({', markerAt + marker.length)
  const toolEnd = nextTool < 0 ? sourceText.indexOf('    ];', markerAt) : nextTool
  const execute = '            async execute(args, exec) {'
  const executeAt = sourceText.indexOf(execute, markerAt)
  if (toolEnd < 0 || executeAt < 0 || executeAt >= toolEnd) {
    throw new Error(`pinned dsh-vision-toolkit ${toolName} execute contract changed`)
  }
  const guard = conditional
    ? '\n                if (args.preview === true) assertWriteAllowed?.(exec);'
    : '\n                assertWriteAllowed?.(exec);'
  return sourceText.slice(0, executeAt + execute.length) + guard + sourceText.slice(executeAt + execute.length)
}

for (const toolName of [
  'vision_trace',
  'vision_crop',
  'vision_pixel_diff',
  'vision_long_screenshot_ocr',
  'vision_extract_foreground',
  'vision_html_screenshot',
]) tools = guardTool(tools, toolName)
for (const toolName of ['vision_ground', 'vision_detect']) tools = guardTool(tools, toolName, true)
await writeFile(toolsPath, tools)

const pathsPath = resolve(staged, 'paths.js')
let paths = await readPinnedText(pathsPath)
paths = replaceExactlyOnce(
  paths,
  'export async function createPathPolicy(workspaceRaw, allowedDirs, outputDirRaw) {',
  'export async function createPathPolicy(workspaceRaw, allowedDirs, outputDirRaw, writable = true) {',
  'read-only path policy',
)
paths = replaceExactlyOnce(
  paths,
  `    let outputDir;
    try {
        await mkdir(outputRaw, { recursive: true });
        outputDir = await realpath(outputRaw);
    }
    catch (error) {
        throw new VisionToolkitError('path', \`output directory is not writable: \${outputRaw}\`, { cause: error });
    }`,
  `    let outputDir = outputRaw;
    if (writable) {
        try {
            await mkdir(outputRaw, { recursive: true });
            outputDir = await realpath(outputRaw);
        }
        catch (error) {
            throw new VisionToolkitError('path', \`output directory is not writable: \${outputRaw}\`, { cause: error });
        }
    }`,
  'read-only output directory',
)
await writeFile(pathsPath, paths)

runtime = replaceExactlyOnce(
  runtime,
  `    pathPolicy(workspace) {
        return createPathPolicy(workspace, this.config.allowedDirs);
    }`,
  `    pathPolicy(workspace, writable = true) {
        return createPathPolicy(workspace, this.config.allowedDirs, undefined, writable);
    }`,
  'read-only runtime path policy',
)
for (const [label, before] of [
  ['glance', `            const policy = await this.pathPolicy(options.workspace);\n            const images = [];`],
  ['locate', `        const policy = await this.pathPolicy(options.workspace);\n        const image = await this.validateImage(request.image, policy, operation);`],
  ['dominant colors', `            const candidateTolerance = integerInRange(request.candidateTolerance, 16, 0, 255, 'dominant_colors.candidateTolerance');\n            const policy = await this.pathPolicy(options.workspace);\n            const image = await this.validateImage(request.image, policy, operation);\n            this.accountImage(image, operation);\n            const region = request.region === undefined ? undefined : parseRegion(request.region);`],
]) {
  runtime = replaceExactlyOnce(
    runtime,
    before,
    before.replace('this.pathPolicy(options.workspace)', 'this.pathPolicy(options.workspace, false)'),
    `${label} read-only path policy`,
  )
}
await writeFile(runtimePath, runtime)

const runtimeInstallPath = resolve(staged, 'runtime-install.js')
let runtimeInstall = await readPinnedText(runtimeInstallPath)
runtimeInstall = replaceExactlyOnce(
  runtimeInstall,
  "const REQUIREMENTS_PATH = join(PACKAGE_ROOT, 'runtime', 'requirements.lock');",
  "const REQUIREMENTS_PATH = join(PACKAGE_ROOT, 'runtime', 'requirements.lock');\nconst WHEELHOUSE_PATH = join(PACKAGE_ROOT, 'runtime', 'wheels', `${process.platform}-${process.arch}`);",
  'wheelhouse path',
)
runtimeInstall = replaceExactlyOnce(
  runtimeInstall,
  '        const match = /^([A-Za-z0-9_.-]+)==([^\\s]+)$/.exec(trimmed);',
  '        const match = /^([A-Za-z0-9_.-]+)==([^\\s]+)(?:\\s+--hash=sha256:[a-f0-9]{64})+$/.exec(trimmed);',
  'hashed requirements parser',
)
runtimeInstall = replaceExactlyOnce(
  runtimeInstall,
  "        UV_CACHE_DIR: join(stateRoot, 'uv-cache'),",
  "        UV_CACHE_DIR: join(stateRoot, 'uv-cache'),\n        PIP_NO_INDEX: '1',\n        UV_NO_INDEX: '1',",
  'offline environment',
)
runtimeInstall = replaceExactlyOnce(
  runtimeInstall,
  "['uv', 'pip', 'install', '--python', venvPython(staging), '--requirement', REQUIREMENTS_PATH]",
  "['uv', 'pip', 'install', '--python', venvPython(staging), '--no-index', '--find-links', WHEELHOUSE_PATH, '--require-hashes', '--requirement', REQUIREMENTS_PATH]",
  'offline uv install',
)
runtimeInstall = replaceExactlyOnce(
  runtimeInstall,
  "[venvPython(staging), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', REQUIREMENTS_PATH]",
  "[venvPython(staging), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-index', '--find-links', WHEELHOUSE_PATH, '--require-hashes', '-r', REQUIREMENTS_PATH]",
  'offline pip install',
)
await writeFile(runtimeInstallPath, runtimeInstall)

await writeFile(resolve(staged, 'index.d.ts'), `
import type { Context } from '@deepseek-ai/cordis'
export declare function apply(
  ctx: Context,
  config?: unknown,
  options?: {
    managed?: boolean
    validateConfig?(value: unknown): void
    assertWriteAllowed?(exec: { agent?: { session?: unknown } }): void
    installImageInputBridge?(runtime: unknown): () => void
    resolveGlanceImages?<T>(images: readonly string[], exec: { signal?: AbortSignal; agent?: { session?: unknown } }, run: (images: readonly string[]) => Promise<T>): Promise<T>
  },
): Promise<() => void>
`)

const tsdown = resolve(root, '../../upstream/deepseek-harness/node_modules/tsdown/dist/index.mjs')
const { build } = await import(pathToFileURL(tsdown).href)
process.chdir(root)
await build({
  entry: 'src/index.ts',
  format: 'esm',
  dts: true,
  clean: true,
  outDir: 'lib',
  deps: {
    alwaysBundle: ['saxes'],
    neverBundle: [/^@deepseek-ai\//, /^@e-mate\/desktop\//, '@standard-schema/spec'],
    onlyBundle: ['saxes', 'xmlchars'],
  },
})

await writeFile(resolve(root, '.build/test-entry.mjs'), `
export { apply } from './upstream-lib/index.js'
export { VisionToolkitWebBackend } from './upstream-lib/web.js'
export { VisionToolkitRuntimeManager } from './upstream-lib/runtime-manager.js'
export { prepareUpstreamRuntime } from './upstream-lib/runtime-install.js'
export { createVisionTools } from './upstream-lib/tools.js'
export { createPathPolicy } from './upstream-lib/paths.js'
`)
await rm(resolve(root, '.test-lib'), { recursive: true, force: true })
await build({
  entry: resolve(root, '.build/test-entry.mjs'),
  format: 'esm',
  clean: true,
  outDir: resolve(root, '.test-lib'),
  deps: {
    alwaysBundle: ['saxes'],
    neverBundle: [/^@deepseek-ai\//, /^@e-mate\/desktop\//, '@standard-schema/spec'],
    onlyBundle: ['saxes', 'xmlchars'],
  },
})

let client = (await readPinnedText(resolve(staged, 'client.js')))
  .replaceAll('@anionex/dsh-vision-toolkit', '@e-mate/dsh-plugin-vision-toolkit')
client = replaceExactlyOnce(
  client,
  `    (0, paste_images_tsx_1.installPasteImages)(ctx);`,
  ``,
  'native attachment first Client',
)
client = replaceExactlyOnce(
  client,
  `const paste_images_tsx_1 = __load_("./paste-images.js");\n`,
  ``,
  'legacy pasted-image Client import',
)
client = replaceSection(
  client,
  `__modules["./paste-images.js"] = function(module, exports, require, __load_) {`,
  `function __resolve(from, request) {`,
  ``,
  'legacy pasted-image Client module',
)
client = replaceExactlyOnce(
  client,
  '(0, jsx_runtime_1.jsx)("option", { value: "openai", children: "OpenAI Chat Completions" }), (0, jsx_runtime_1.jsx)("option", { value: "anthropic", children: "Anthropic Messages" })',
  '(0, jsx_runtime_1.jsx)("option", { value: "openai", children: "OpenAI Chat Completions" }), (0, jsx_runtime_1.jsx)("option", { value: "responses", children: "OpenAI Responses" }), (0, jsx_runtime_1.jsx)("option", { value: "anthropic", children: "Anthropic Messages" })',
  'Responses Client option',
)
const clientTransforms = [
  [`"aria-label": t('anthropicThinking'), value:`, `"aria-label": t('anthropicThinking'), disabled: !snapshot.writable || busy, value:`, 1],
  ['{ value: draft.userAgent,', '{ disabled: !snapshot.writable || busy, value: draft.userAgent,', 1],
  ['{ value: draft.language,', '{ disabled: !snapshot.writable || busy, value: draft.language,', 1],
  ['{ inputMode: "numeric", value:', '{ inputMode: "numeric", disabled: !snapshot.writable || busy, value:', 4],
  ['{ value: draft.runtimeMode,', '{ disabled: !snapshot.writable || busy, value: draft.runtimeMode,', 1],
  ['{ value: draft.toolkitPath,', '{ disabled: !snapshot.writable || busy, value: draft.toolkitPath,', 1],
  ['{ placeholder: "python3", value:', '{ placeholder: "python3", disabled: !snapshot.writable || busy, value:', 1],
  ['{ rows: 3, value:', '{ rows: 3, disabled: !snapshot.writable || busy, value:', 1],
]
for (const [before, after, expected] of clientTransforms) {
  if (client.split(before).length - 1 !== expected) {
    throw new Error('pinned dsh-vision-toolkit managed Client contract changed')
  }
  client = client.replaceAll(before, after)
}
client = client.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n')
await writeFile(resolve(root, 'lib/client.js'), client)

const requirementsLock = await readFile(resolve(root, 'runtime/requirements.lock'))
await rm(resolve(root, 'runtime'), { recursive: true, force: true })
await cp(resolve(source, 'runtime'), resolve(root, 'runtime'), { recursive: true, force: true })
await writeFile(resolve(root, 'runtime/requirements.lock'), requirementsLock)
await cp(resolve(source, 'vendor'), resolve(root, 'vendor'), { recursive: true, force: true })
const target = process.env.EMATE_COMPONENT_TARGET
if (target !== undefined) {
  const python = process.env.EMATE_BUILD_PYTHON
    ?? (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(python, [
    resolve(root, 'scripts/prepare-wheels.py'),
    '--root', root,
    '--targets', target,
  ], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`Vision wheel preparation failed:\n${result.stdout}${result.stderr}`)
  }
}
if (!process.argv.includes('--keep-staged') && process.env.EMATE_COMPONENT_CHECK !== '1') {
  await rm(resolve(root, '.build'), { recursive: true, force: true })
}
