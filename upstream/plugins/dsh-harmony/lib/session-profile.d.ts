export declare const HARMONY_SESSION_PROFILE_FILE = "harmony-sessions.json";
export declare const HARMONY_INSTANCE_PROFILE_FILE = "harmony-instance.json";
export interface HarmonySessionPatch {
    key: string;
    providerVersion: string;
    fingerprint: string;
}
export interface HarmonySessionPatchProfile {
    recordedAt: number;
    patches: HarmonySessionPatch[];
}
export interface HarmonySessionPatchDifference {
    missing: string[];
    added: string[];
    changed: string[];
    reordered: boolean;
}
export type HarmonySessionPatchCheck = {
    sessionId: string;
    state: 'untracked';
    current: HarmonySessionPatchProfile;
} | {
    sessionId: string;
    state: 'match';
    recorded: HarmonySessionPatchProfile;
    current: HarmonySessionPatchProfile;
} | {
    sessionId: string;
    state: 'mismatch';
    recorded: HarmonySessionPatchProfile;
    current: HarmonySessionPatchProfile;
    difference: HarmonySessionPatchDifference;
};
export interface HarmonyInstancePatchProfile extends HarmonySessionPatchProfile {
    profile: string;
}
export type HarmonyInstancePatchCheck = {
    state: 'initialized';
    current: HarmonyInstancePatchProfile;
} | {
    state: 'match';
    recorded: HarmonyInstancePatchProfile;
    current: HarmonyInstancePatchProfile;
} | {
    state: 'mismatch';
    recorded: HarmonyInstancePatchProfile;
    current: HarmonyInstancePatchProfile;
    difference: HarmonySessionPatchDifference;
};
export declare function harmonyDataRoot(profileDir: string): string;
export declare class HarmonySessionProfileStore {
    private readonly rootDir;
    private tail;
    constructor(rootDir: string);
    bind(sessionId: string, current: HarmonySessionPatchProfile): Promise<HarmonySessionPatchProfile>;
    check(sessionId: string, current: HarmonySessionPatchProfile): HarmonySessionPatchCheck;
    flush(): Promise<void>;
    startInstance(profileName: string, current: HarmonySessionPatchProfile): Promise<HarmonyInstancePatchCheck>;
}
export declare function compareSessionPatchProfiles(recorded: HarmonySessionPatchProfile, current: HarmonySessionPatchProfile): HarmonySessionPatchDifference;
