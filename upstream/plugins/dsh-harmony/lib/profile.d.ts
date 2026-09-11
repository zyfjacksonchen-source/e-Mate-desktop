import { type HarmonyActivePlugin, type HarmonyPluginCompatibilityDeclarations, type HarmonyPluginCompatibilityFinding } from './compatibility.js';
import { type HarmonyOrderViolation, type HarmonyProvider } from './order.js';
export interface InstalledPlugin extends HarmonyProvider {
    dir: string;
    version: string;
    description: string;
    patches: string[];
    compatibility: HarmonyPluginCompatibilityDeclarations;
    author: string;
    contributors: string[];
    homepage: string;
    bugs: string;
    license: string;
}
export interface HarmonyProfile {
    dir: string;
    workerThreads: number;
    order: string[];
    patchOrder: string[];
    disabled: string[];
    plugins: InstalledPlugin[];
    compatibility: HarmonyPluginCompatibilityFinding[];
}
export interface HarmonyProfilePluginView {
    name: string;
    version: string;
    description: string;
    harmony: boolean;
    patches: string[];
    patchCount?: number;
    before: string[];
    after: string[];
    compatibility: HarmonyPluginCompatibilityDeclarations;
    author: string;
    contributors: string[];
    homepage: string;
    bugs: string;
    license: string;
}
export interface HarmonyProfileView {
    revision: number;
    dir: string;
    workerThreads: number;
    order: string[];
    patchOrder: string[];
    disabled: string[];
    plugins: HarmonyProfilePluginView[];
    orderViolations: HarmonyOrderViolation[];
    patchOrderViolations: HarmonyOrderViolation[];
    compatibility: HarmonyPluginCompatibilityFinding[];
}
export interface HarmonyProfileUpdate {
    expectedRevision?: number;
    workerThreads?: number;
    order?: string[];
    patchOrder?: string[];
    disabled?: string[];
}
export declare const HARMONY_STATE_FILE = "harmony.json";
export declare const HARMONY_PLUGIN = "dsh-harmony";
export declare function pinHarmonyOrder(order: string[]): string[];
export interface HarmonyState {
    workerThreads: number;
    order: string[];
    patchOrder: string[];
    disabled: string[];
}
export declare class HarmonyProfileConflictError extends Error {
    readonly expected: number;
    readonly actual: number;
    readonly code = "HARMONY_PROFILE_CONFLICT";
    constructor(expected: number, actual: number);
}
export declare function saveHarmonyState(profileDir: string, state: HarmonyState): Promise<void>;
export declare function synchronizeHarmonyProfile(profileDir: string, requested?: string[], activePlugins?: HarmonyActivePlugin[], additional?: string[]): HarmonyProfile;
export declare const MAX_HARMONY_WORKER_THREADS = 32;
export declare function groupHarmonyPatchOrder(order: string[], current: string[]): string[];
export declare function prepareHarmonyProfileUpdate(profile: HarmonyProfile, input: HarmonyProfileUpdate): HarmonyProfile;
export declare function createHarmonyProfileView(profile: HarmonyProfile, patchCounts?: ReadonlyMap<string, number>, patchOrderViolations?: HarmonyOrderViolation[], revision?: number): HarmonyProfileView;
export declare function readHarmonyProfile(profileDir: string, configured?: string[]): HarmonyProfileView;
/** Validate and normalize an update for a stopped profile without writing it. */
export declare function preflightHarmonyProfileUpdate(profileDir: string, input: HarmonyProfileUpdate, configured?: string[]): HarmonyProfileView;
/** Atomically update a stopped profile. Running profiles must use HarmonyService.updateProfile(). */
export declare function updateStoppedHarmonyProfile(profileDir: string, input: HarmonyProfileUpdate, configured?: string[]): Promise<HarmonyProfileView>;
