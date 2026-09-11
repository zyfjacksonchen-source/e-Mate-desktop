export interface FileTransformHooks {
    targetFilename(filename: string): string | undefined;
    isModuleSourceLoading(filename: string): boolean;
    transform(filename: string, source: string): string;
}
export declare function installNodeFileTransforms(runtime: FileTransformHooks): void;
export interface ModuleTransformHooks<Loader> {
    aliases: {
        index: string;
        plugin: string;
        settings: string;
        manifest: string;
    };
    currentGeneration(): number;
    canonicalFilename(filename: string): string;
    targetFilename(filename: string, generation: number): string | undefined;
    packageDirectory(filename: string): string | undefined;
    resolveProfileDependency(specifier: string, parentUrl: string | undefined, generation: number): string | undefined;
    recordDependency(parentUrl: string | undefined, childUrl: string, generation: number): void;
    resolveTypeScriptDependency(specifier: string, parentUrl: string | undefined, generation: number): string | undefined;
    activeTypeScriptLoader(filename: string, generation: number): Loader | undefined;
    transpileTypeScript(filename: string, source: string, loader: Loader): {
        format: 'module' | 'commonjs';
        source: string;
    };
    transform(filename: string, source: string, generation: number): string;
    beginModuleSourceLoad(filename: string): void;
    endModuleSourceLoad(filename: string): void;
}
export declare function installNodeModuleHooks<Loader>(runtime: ModuleTransformHooks<Loader>): void;
