export type HarmonyPluginCompatibilityRanges = Record<string, string>;
export interface HarmonyPluginCompatibilityDeclarations {
    requires: HarmonyPluginCompatibilityRanges;
    conflicts: HarmonyPluginCompatibilityRanges;
    integrates: HarmonyPluginCompatibilityRanges;
}
export interface HarmonyPluginPackage {
    name: string;
    version: string;
    compatibility: HarmonyPluginCompatibilityDeclarations;
}
export interface HarmonyActivePlugin {
    name: string;
    entryIds: string[];
}
export interface HarmonyPluginRef {
    package: string;
    version: string;
    entryIds: string[];
}
export type HarmonyPluginCompatibilityFinding = {
    kind: 'conflict';
    left: HarmonyPluginRef;
    right: HarmonyPluginRef;
    declaredBy: string[];
} | {
    kind: 'requirement';
    owner: HarmonyPluginRef;
    target: {
        package: string;
        range: string;
        version: string | null;
        entryIds: string[];
    };
    reason: 'missing' | 'inactive' | 'version';
} | {
    kind: 'integration';
    owner: HarmonyPluginRef;
    target: HarmonyPluginRef;
    range: string;
};
export declare function parsePluginCompatibility(value: unknown, owner: string): HarmonyPluginCompatibilityDeclarations;
export declare function evaluatePluginCompatibility(packages: HarmonyPluginPackage[], activePlugins: HarmonyActivePlugin[]): HarmonyPluginCompatibilityFinding[];
