import type { HarmonyInspection, HarmonyProfileUpdateResult, HarmonyRuntimeProfileUpdateResult } from './index.js';
import { type HarmonyProfileUpdate } from './profile.js';
import type { HarmonyReloadStatus } from './installer.js';
export interface HarmonyRuntimeStatus {
    profile: HarmonyRuntimeProfileUpdateResult['profile'];
    patches: HarmonyInspection['patches'];
    reload: HarmonyReloadStatus;
}
export interface HarmonyPatchUpdateResult {
    result: HarmonyRuntimeProfileUpdateResult;
    patches: HarmonyInspection['patches'];
}
export type HarmonyRuntimeReloadResult = HarmonyRuntimeStatus;
export declare function publishRuntimeAddress(profileDir: string, url: string, token: string): () => void;
export declare function readHarmonyRuntime(profileDir: string): Promise<HarmonyRuntimeStatus | undefined>;
export declare function inspectHarmonyRuntime(profileDir: string, packageName?: string, file?: string): Promise<HarmonyInspection | undefined>;
export declare function updateRuntimePatch(profileDir: string, input: {
    key?: string;
    owner?: string;
    enabled: boolean;
}): Promise<HarmonyPatchUpdateResult | undefined>;
export declare function reloadHarmonyRuntime(profileDir: string, provider?: string): Promise<HarmonyRuntimeReloadResult | undefined>;
export declare function updateRuntimeProfile(profileDir: string, input: HarmonyProfileUpdate): Promise<HarmonyRuntimeProfileUpdateResult | undefined>;
/** Update a profile through its running transaction, or atomically on disk when stopped. */
export declare function updateHarmonyProfile(profileDir: string, input: HarmonyProfileUpdate, configured?: string[]): Promise<HarmonyProfileUpdateResult>;
