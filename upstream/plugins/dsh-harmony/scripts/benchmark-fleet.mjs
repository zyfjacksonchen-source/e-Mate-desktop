import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { satisfies } from 'semver';
import { applySourcePatch } from '../lib/transform.js';
function fleetRoot() {
    const argument = process.argv.slice(2).find(value => !value.startsWith('--'));
    const root = resolve(argument ?? process.env.DSH_AGENT_FLEET_ROOT
        ?? join(dirname(fileURLToPath(import.meta.url)), '../../dsh-agent-fleet'));
    if (!existsSync(join(root, 'harmony/hero-team-entry.cjs'))) {
        throw new Error(`dsh-agent-fleet checkout not found at ${root}`);
    }
    return root;
}
function sourcePatches(declarations) {
    const patches = [];
    const visit = (declaration) => {
        if ('patches' in declaration)
            declaration.patches.forEach(visit);
        else if ('select' in declaration)
            patches.push(declaration);
    };
    declarations.forEach(visit);
    return patches;
}
function packageVersion(directory) {
    try {
        return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
    }
    catch {
        return undefined;
    }
}
function targetFilename(root, patch) {
    const direct = join(root, 'node_modules', patch.target.package);
    const pnpm = join(root, 'node_modules/.pnpm');
    const directories = [direct];
    if (existsSync(pnpm)) {
        for (const entry of readdirSync(pnpm).sort()) {
            directories.push(join(pnpm, entry, 'node_modules', patch.target.package));
        }
    }
    for (const directory of directories) {
        const filename = join(directory, patch.target.file);
        if (!existsSync(filename))
            continue;
        const version = packageVersion(directory);
        if (patch.target.version === undefined || version !== undefined
            && satisfies(version, patch.target.version, { includePrerelease: true }))
            return filename;
    }
    throw new Error(`target ${patch.target.package}/${patch.target.file} is not installed under ${root}`);
}
function targetSources(root, patches) {
    const targets = new Map();
    for (const patch of patches) {
        const filename = targetFilename(root, patch);
        const current = targets.get(filename) ?? {
            filename,
            original: readFileSync(filename, 'utf8'),
            patches: [],
        };
        current.patches.push(patch);
        targets.set(filename, current);
    }
    return [...targets.values()];
}
function runGeneration(targets, editedPatch) {
    const started = performance.now();
    const timings = [];
    for (const target of targets) {
        const targetStarted = performance.now();
        let source = target.original;
        let sourceAst;
        let delta;
        const history = [];
        for (const patch of target.patches) {
            const activePatch = patch.id === editedPatch
                ? {
                    ...patch,
                    apply(context) {
                        patch.apply(context);
                        context.edit.append('\n/* dsh-harmony benchmark edit */');
                    },
                }
                : patch;
            const registered = {
                key: `dsh-agent-fleet/${patch.id}`,
                owner: 'dsh-agent-fleet',
                declaration: 'harmony/hero-team-entry.cjs',
                fingerprint: `${patch.id}${patch.id === editedPatch ? ':edited' : ':base'}`,
            };
            const result = applySourcePatch(target.filename, `${patch.target.package}/${patch.target.file}`, source, target.original, registered, activePatch, history, () => history, sourceAst, delta);
            source = result.source;
            sourceAst = result.sourceAst;
            delta = result.delta;
            history.push({ owner: registered.owner, source });
        }
        timings.push({
            target: `${target.patches[0].target.package}/${target.patches[0].target.file}`,
            bytes: target.original.length,
            patches: target.patches.length,
            milliseconds: performance.now() - targetStarted,
        });
    }
    return { milliseconds: performance.now() - started, targets: timings };
}
function runAutomaton() {
    const arrays = 1_000;
    const body = Array.from({ length: arrays }, (_, index) => `const values${index} = [1,2,3,4,5,6,7,8,9,10];`).join('\n');
    const selector = 'NumericLiteral[text="1"] ~ NumericLiteral:nth-last-child(1)';
    const patch = {
        id: 'automaton-benchmark',
        target: { package: 'benchmark', file: 'automaton.js' },
        select: selector,
        expect: arrays,
        apply() { },
    };
    const run = (source) => {
        const started = performance.now();
        const result = applySourcePatch('/tmp/dsh-harmony-automaton.js', 'benchmark/automaton.js', source, source, { key: 'benchmark/automaton', owner: 'benchmark', declaration: 'benchmark' }, patch, [], () => []);
        return { matches: result.matches, milliseconds: performance.now() - started };
    };
    const cold = run(`${body}\nconst outside = 1\n`);
    const changed = run(`${body}\nconst outside = 200\n`);
    return {
        matches: cold.matches,
        coldMilliseconds: cold.milliseconds,
        changedGenerationMilliseconds: changed.milliseconds,
    };
}
const root = fleetRoot();
const requireFromFleet = createRequire(join(root, 'package.json'));
const declarations = requireFromFleet(join(root, 'harmony/hero-team-entry.cjs'));
const targets = targetSources(root, sourcePatches(declarations));
const cold = runGeneration(targets);
const warm = runGeneration(targets);
const editedPatch = 'fleet-global-session-header';
const edited = runGeneration(targets, editedPatch);
const automaton = runAutomaton();
const result = {
    root,
    bytes: targets.reduce((total, target) => total + target.original.length, 0),
    patches: targets.reduce((total, target) => total + target.patches.length, 0),
    cold,
    warm,
    editedPatch,
    edited,
    automaton,
};
if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
}
else {
    process.stdout.write([
        `dsh-harmony Fleet transform benchmark (${result.patches} patches, ${targets.length} targets, ${result.bytes} bytes)`,
        `cold: ${cold.milliseconds.toFixed(2)} ms`,
        `same-process cross-generation: ${warm.milliseconds.toFixed(2)} ms`,
        `one Patch fingerprint changed (${editedPatch}): ${edited.milliseconds.toFixed(2)} ms`,
        `full automaton (${automaton.matches} matches): ${automaton.coldMilliseconds.toFixed(2)} ms cold, ${automaton.changedGenerationMilliseconds.toFixed(2)} ms after unrelated source change`,
        ...cold.targets.map((target, index) => `${target.target}: ${target.milliseconds.toFixed(2)} ms cold, ${warm.targets[index].milliseconds.toFixed(2)} ms warm`),
        '',
    ].join('\n'));
}
