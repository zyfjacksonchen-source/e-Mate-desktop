export interface HarmonyPatchScheduleItem {
    key: string;
    files: readonly string[];
}
/**
 * Slice a total Patch order into per-file queues. A batch contains only Patches
 * that are simultaneously at the head of every file they affect, so its items
 * are independent and may execute concurrently.
 */
export declare function schedulePatchBatches(items: readonly HarmonyPatchScheduleItem[]): string[][];
