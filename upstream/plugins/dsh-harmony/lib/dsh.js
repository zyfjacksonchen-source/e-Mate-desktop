import { readFileSync, realpathSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
const require = createRequire(import.meta.url);
const configuredEntry = process.env.DSH_HARMONY_DSH_ENTRY;
export const dshEntry = configuredEntry === undefined
    ? require.resolve('@deepseek-ai/dsh/lib/bin.js')
    : resolve(configuredEntry);
const dshRequire = createRequire(dshEntry);
process.env.DSH_HARMONY_ACTIVE_DSH_ENTRY = dshEntry;
process.env.DSH_HARMONY_ACTIVE = '1';
const appBoot = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
export const { initProfile, PROFILE_TEMPLATES, resolveProfileDir } = appBoot;
/** Initialize a shipped profile across the legacy array and current object template shapes. */
export function initShippedProfile(dir, name) {
    const template = PROFILE_TEMPLATES[name];
    if (template === undefined)
        return false;
    const bundles = Array.isArray(template) ? template : template.bundles;
    const patchReload = Array.isArray(template) ? undefined : template.patchReload;
    if (!Array.isArray(bundles) || !bundles.every(bundle => typeof bundle === 'string')) {
        throw new TypeError(`dsh-harmony: invalid DSH profile template ${JSON.stringify(name)}`);
    }
    ;
    initProfile(dir, bundles, patchReload);
    return true;
}
const resolvedDshInstallAnchor = findPackageJSON('@deepseek-ai/dsh', pathToFileURL(dshEntry));
if (resolvedDshInstallAnchor === undefined)
    throw new Error('dsh-harmony: cannot locate the active @deepseek-ai/dsh package');
const dshInstallAnchor = resolvedDshInstallAnchor;
function packageNameOf(specifier) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || specifier.includes(':')) {
        return undefined;
    }
    return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}
function collectEntryPackages(entries, packages) {
    for (const entry of entries) {
        const name = packageNameOf(entry.name);
        if (name !== undefined)
            packages.add(name);
        if (entry.group && Array.isArray(entry.config))
            collectEntryPackages(entry.config, packages);
    }
}
function readManifest(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
function harmonyRequirements(manifest) {
    const value = manifest.dsh?.harmony?.requires;
    if (value === undefined)
        return {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`dsh-harmony: ${JSON.stringify(manifest.name)} dsh.harmony.requires must be an object`);
    }
    for (const [name, range] of Object.entries(value)) {
        if (name.length === 0 || typeof range !== 'string' || semver.validRange(range) === null) {
            throw new TypeError(`dsh-harmony: ${JSON.stringify(manifest.name)} has invalid Harmony Provider requirement ${JSON.stringify(name)}`);
        }
    }
    return value;
}
function realFile(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
export function configuredProfileActivation(name, profileDir, patchFiles = [], userLayer = true) {
    const profileApi = appBoot;
    if (typeof profileApi.loadProfile !== 'function' || typeof profileApi.composeEntries !== 'function') {
        return { candidates: [], patches: [] };
    }
    const home = dirname(dirname(profileDir));
    const profile = profileApi.loadProfile('dsh', name, dshInstallAnchor, home, { userLayer });
    const layers = [
        profile.layers.flatMap(layer => layer.patches),
        profile.patches,
    ];
    if (userLayer) {
        layers.push(profileApi.loadOptionalPatches?.('dsh', join(home, 'cordis.patch.yml')) ?? []);
        if (profileApi.loadOverlayPatches !== undefined) {
            layers.push(patchFiles.flatMap(file => profileApi.loadOverlayPatches('dsh', resolve(file))));
        }
    }
    const configuredPackages = new Set(profile.layers.map(layer => layer.packageName));
    collectEntryPackages(profileApi.composeEntries(layers), configuredPackages);
    const bundleManifests = new Map(profile.layers.map(layer => [
        layer.packageName,
        join(layer.packageDir, 'package.json'),
    ]));
    const anchors = [
        join(profileDir, 'package.json'),
        ...profile.layers.map(layer => join(realpathSync(layer.packageDir), 'package.json')),
        dshInstallAnchor,
    ];
    const manifests = [...configuredPackages].map(packageName => {
        const bundled = bundleManifests.get(packageName);
        if (bundled !== undefined)
            return bundled;
        for (const anchor of anchors) {
            try {
                const manifest = findPackageJSON(packageName, pathToFileURL(anchor));
                if (manifest !== undefined)
                    return manifest;
            }
            catch { }
        }
        return packageName;
    });
    const candidates = new Map();
    const requiredPatches = [];
    const knownPatches = new Set(patchFiles.map(file => realFile(file)));
    const visiting = new Set();
    const visited = new Set();
    const visit = (manifestPath) => {
        if (!manifestPath.endsWith('package.json'))
            return;
        const canonical = realFile(manifestPath);
        if (visited.has(canonical) || visiting.has(canonical))
            return;
        visiting.add(canonical);
        const manifest = readManifest(canonical);
        candidates.set(manifest.name, manifestPath);
        for (const [requiredName, range] of Object.entries(harmonyRequirements(manifest))) {
            let requiredManifest;
            try {
                requiredManifest = findPackageJSON(requiredName, pathToFileURL(canonical));
            }
            catch { }
            if (requiredManifest === undefined) {
                throw new Error(`dsh-harmony: ${manifest.name} requires Harmony Provider ${requiredName}@${range}, but it is not installed`);
            }
            const requiredCanonical = realFile(requiredManifest);
            const required = readManifest(requiredCanonical);
            if (required.name !== requiredName || !semver.satisfies(required.version ?? '0.0.0', range, { includePrerelease: true })) {
                throw new Error(`dsh-harmony: ${manifest.name} requires Harmony Provider ${requiredName}@${range}, found ${required.name}@${required.version ?? '0.0.0'}`);
            }
            if (required.dsh?.harmony === undefined) {
                throw new Error(`dsh-harmony: ${manifest.name} requires ${requiredName}@${range}, but it is not a Harmony Provider`);
            }
            visit(requiredCanonical);
            candidates.set(required.name, requiredManifest);
            const declaredPatch = required.dsh.bundle?.patch;
            if (declaredPatch === undefined || configuredPackages.has(required.name))
                continue;
            const patch = realFile(join(dirname(requiredCanonical), declaredPatch));
            if (!knownPatches.has(patch)) {
                knownPatches.add(patch);
                requiredPatches.push(patch);
            }
            configuredPackages.add(required.name);
        }
        visiting.delete(canonical);
        visited.add(canonical);
    };
    for (const manifest of manifests)
        visit(manifest);
    for (const manifest of manifests) {
        if (!manifest.endsWith('package.json'))
            candidates.set(manifest, manifest);
    }
    return { candidates: [...candidates.values()], patches: requiredPatches };
}
export function configuredProfileCandidates(name, profileDir, patchFiles = [], userLayer = true) {
    return configuredProfileActivation(name, profileDir, patchFiles, userLayer).candidates;
}
