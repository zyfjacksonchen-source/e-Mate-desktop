import type { HarmonyPatchTarget } from '../index.js';
export declare const LEGACY_CLIENT_RANGE = ">=0.1.1-rc.2 <0.1.2-0";
export declare const LEGACY_SHARED_RANGE = ">=0.1.0-rc.8 <0.1.2-0";
export declare const DSH_012_RANGE = ">=0.1.2-alpha.4 <0.1.3-0";
export declare function activeDshVersion(): string;
export declare function sessionProfileTarget(version: string): HarmonyPatchTarget;
