import type { Context } from '@deepseek-ai/cordis';
interface ReloadFiber {
    uid: number | null;
    inject?: unknown;
    runtime: {
        callback: unknown;
    } | null;
}
interface ReloadableEntry {
    id?: string;
    options: {
        name: string;
        inject?: unknown;
    };
    fiber?: ReloadFiber;
    parent: {
        tree: {
            ctx?: {
                baseUrl?: string;
            };
            import(name: string, getOuterStack?: () => string[]): unknown;
        };
    };
    loader: {
        unwrapExports(value: unknown): unknown;
    };
    getOuterStack(): string[];
    _dispose(fiber?: ReloadFiber): Promise<void>;
    _start(plugin: unknown): Promise<void>;
}
export declare function reloadEntries(entries: ReloadableEntry[], generation: number, invalidatedPackages?: Iterable<string>): Promise<() => Promise<void>>;
export declare function apply(ctx: Context): Promise<void>;
export declare const inject: string[];
export {};
