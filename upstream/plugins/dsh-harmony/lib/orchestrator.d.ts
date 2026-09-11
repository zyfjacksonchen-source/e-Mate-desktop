import ts from 'typescript';
export interface HarmonyModuleDependency {
    kind: 'import' | 'require' | 'dynamic-import';
    specifier: string;
}
export interface HarmonyModuleLoadPlan {
    filename: string;
    fingerprint: string;
    dependencies: HarmonyModuleDependency[];
    declaredInject: string[];
    declaredProvide: string[];
    scopedInject: string[];
    possibleProvide: string[];
    dynamicMetadata: boolean;
}
export interface HarmonyEntryLoadPlan {
    id: string;
    name: string;
    generation: number;
    inject: string[];
    provide: string[];
    fingerprint: string;
}
export interface HarmonyPackageLoadPlan {
    name: string;
    directory: string;
    version: string;
}
export interface HarmonyPatchLoadPlan {
    key: string;
    owner: string;
    targets: Array<{
        package: string;
        file: string;
    }>;
}
export interface HarmonyGenerationLoadPlan {
    generation: number;
    packages: HarmonyPackageLoadPlan[];
    patches: HarmonyPatchLoadPlan[];
    modules: HarmonyModuleLoadPlan[];
    entries: HarmonyEntryLoadPlan[];
}
export declare function analyzeModuleLoad(filename: string, source: string, sourceFile?: ts.SourceFile, knownFingerprint?: string): HarmonyModuleLoadPlan;
export declare function dependencyNames(value: unknown): string[];
export declare function observeEntryLoad(input: {
    id: string;
    name: string;
    generation: number;
    entryInject?: unknown;
    plugin: unknown;
}): HarmonyEntryLoadPlan;
export declare function clearModuleAnalysisCache(): void;
