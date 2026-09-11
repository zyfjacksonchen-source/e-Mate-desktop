import type { ReadStream, WriteStream } from 'node:tty';
import type { HarmonyPatchStatus, HarmonyProfileUpdateResult } from './index.js';
import { type HarmonyLocale } from './locale.js';
import { type HarmonyProfileView } from './profile.js';
export declare function renderHarmonyTui(profile: HarmonyProfileView, selected: number, message: string, height?: number, locale?: HarmonyLocale): string;
export declare function renderHarmonyPatchTui(profile: HarmonyProfileView, patches: HarmonyPatchStatus[], selected: number, message: string, height?: number, locale?: HarmonyLocale): string;
export declare function saveHarmonyTuiOrder(profileDir: string, order: string[], configured?: string[]): Promise<HarmonyProfileUpdateResult>;
export declare function saveHarmonyTuiPatchOrder(profileDir: string, patchOrder: string[], configured?: string[]): Promise<HarmonyProfileUpdateResult>;
export declare function runHarmonyTui(profileDir: string, input?: ReadStream, output?: WriteStream, locale?: HarmonyLocale, configured?: string[]): Promise<void>;
