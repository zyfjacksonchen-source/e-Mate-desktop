import type { HarmonyPatchInspection, HarmonyPatchStatus } from './index.js';
import type { HarmonySessionPatchProfile } from './session-profile.js';
import { patchOrderViolations } from './order.js';
import { type HarmonyActivePlugin } from './compatibility.js';
import type { HarmonyProfile } from './profile.js';
import { type SourceDelta } from './transform.js';
import { type HarmonyEntryLoadPlan, type HarmonyGenerationLoadPlan, type HarmonyModuleLoadPlan } from './orchestrator.js';
interface PackageInfo {
    dir: string;
    name: string;
    version: string;
    type?: string;
    harmony?: {
        patches?: string[];
        before?: string[];
        after?: string[];
    };
}
interface TransformRecord {
    filename: string;
    generation: number;
    packageVersion: string;
    source: string;
    output: string;
    inspection: CompactPatchInspection;
    module?: HarmonyModuleLoadPlan;
}
export interface ParallelInspectionTask {
    profileDir: string;
    requestedProfilePackages?: string[];
    additionalProfilePackages: string[];
    activePlugins: HarmonyActivePlugin[];
    order: string[];
    disabled: string[];
    keys: string[];
    generation: number;
}
export interface ParallelInspectionResult {
    generation: number;
    records: TransformRecord[];
    statuses: HarmonyPatchStatus[];
    targetFiles: Array<[string, TargetFileRecord]>;
    targetIndexComplete: boolean;
    typescriptLoaderPackages: string[];
}
interface CompactPatchStep {
    key: string;
    owner: string;
    matches: number;
    delta: SourceDelta;
}
interface CompactPatchInspection {
    package: string;
    file: string;
    final: string;
    steps: CompactPatchStep[];
}
interface TargetFileRecord {
    filename: string;
    package: PackageInfo;
}
export interface ProfileTransaction {
    generation: number;
    profile: HarmonyProfile;
    targets: PatchTargets;
    commit(): Promise<void>;
    rollback(): void;
}
export type PatchTargets = Map<string, Set<string>>;
export interface HarmonyStartupPerformance {
    started: bigint;
    prepareMs: number;
    transformMs: number;
    targetPackages: number;
    targetFiles: number;
}
export declare function recordStartupPerformance(value: HarmonyStartupPerformance): void;
export declare function consumeStartupPerformance(): HarmonyStartupPerformance | undefined;
export declare function retainedGenerationCount(): number;
export declare function discoverPackage(packageDir: string): void;
export declare function synchronizeProfile(profileDir: string, installed?: string[], enabledPlugins?: HarmonyActivePlugin[], additional?: string[]): HarmonyProfile;
export declare function currentProfile(): HarmonyProfile;
export declare function synchronizePluginOrder(installed: string[]): HarmonyProfile;
export declare function beginStartupUpdate(enabledPlugins: HarmonyActivePlugin[]): ProfileTransaction;
export declare function beginPluginUpdate(force?: boolean, enabledPlugins?: HarmonyActivePlugin[], additional?: string[]): ProfileTransaction;
export declare function beginProfileUpdate(input: {
    workerThreads?: number;
    order?: string[];
    patchOrder?: string[];
    disabled?: string[];
}): ProfileTransaction;
export declare function watchProfile(onChange: () => void | Promise<void>, onError: (error: unknown) => void): () => void;
export declare function subscribe(listener: (targets: PatchTargets, generation: number) => void): () => void;
export declare function subscribePatchStatuses(listener: () => void): () => void;
export declare function getPatchStatuses(): HarmonyPatchStatus[];
export declare function currentSessionPatchProfile(recordedAt?: number): HarmonySessionPatchProfile;
export declare function getPatchOrderViolations(): ReturnType<typeof patchOrderViolations>;
export declare function getPatchInspections(packageName?: string, file?: string): HarmonyPatchInspection[];
export declare function inspectPatchTargets(): HarmonyPatchInspection[];
export declare function inspectPatchTargetsAsync(): Promise<HarmonyPatchInspection[]>;
export declare function inspectUnresolvedPatchTargets(): HarmonyPatchInspection[];
export declare function inspectUnresolvedPatchTargetsAsync(): Promise<HarmonyPatchInspection[]>;
export declare function executeParallelInspectionTask(task: ParallelInspectionTask): ParallelInspectionResult;
export declare function preflightProfileUpdate(input: {
    workerThreads?: number;
    order?: string[];
    patchOrder?: string[];
    disabled?: string[];
}): void;
export declare function installFileTransforms(): void;
export declare function resolveProfileDependency(specifier: string, _parentUrl: string | undefined, requestedGeneration?: number): string | undefined;
export declare function recordModuleDependency(parentUrl: string | undefined, childUrl: string, requestedGeneration?: number): void;
export declare function dependentPackages(packageNames: Iterable<string>, requestedGeneration?: number): Set<string>;
export declare function recordEntryLoad(input: {
    id: string;
    name: string;
    entryInject?: unknown;
    plugin: unknown;
    generation?: number;
}): HarmonyEntryLoadPlan | undefined;
export declare function removeEntryLoad(id: string, requestedGeneration?: number): void;
export declare function getLoadPlan(requestedGeneration?: number): HarmonyGenerationLoadPlan | undefined;
export declare function resolveProfilePackageManifest(specifier: string, requestedGeneration?: number): string | undefined;
export declare function plannedClientDependencies(filename: string, requestedGeneration?: number): string[];
export declare function installModuleHooks(): void;
export declare function prepareModuleReload(specifier: string, baseUrl?: string, packageUpdates?: Map<string, () => void>): {
    restore(): void;
    load?: () => unknown;
} | undefined;
export declare function discoverProfile(profileDir: string, includeHarmony?: boolean, configured?: string[]): void;
export declare function packageNameOf(specifier: string): string | undefined;
export {};
