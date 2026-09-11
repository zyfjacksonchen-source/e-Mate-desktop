export declare const dshEntry: string;
export declare const initProfile: typeof import("@deepseek-ai/dsh-app-boot").initProfile, PROFILE_TEMPLATES: Record<string, readonly string[]>, resolveProfileDir: typeof import("@deepseek-ai/dsh-app-boot").resolveProfileDir;
/** Initialize a shipped profile across the legacy array and current object template shapes. */
export declare function initShippedProfile(dir: string, name: string): boolean;
export interface ConfiguredProfileActivation {
    candidates: string[];
    patches: string[];
}
export declare function configuredProfileActivation(name: string, profileDir: string, patchFiles?: string[], userLayer?: boolean): ConfiguredProfileActivation;
export declare function configuredProfileCandidates(name: string, profileDir: string, patchFiles?: string[], userLayer?: boolean): string[];
