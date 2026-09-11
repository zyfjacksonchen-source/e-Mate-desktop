import type { Context } from '@deepseek-ai/cordis';
export declare function waitForRuntimeChoice(ctx: Context): Promise<void>;
export interface HarmonyReloadStatus {
    sequence: number;
    state: 'idle' | 'reloading' | 'succeeded' | 'failed';
    error?: string;
}
export declare function registerActiveRuntimeRoute(ctx: Context, reloadStatus: () => HarmonyReloadStatus): void;
