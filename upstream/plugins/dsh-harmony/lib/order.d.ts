export interface HarmonyProvider {
    name: string;
    before: string[];
    after: string[];
}
export interface HarmonyOrderViolation {
    before: string;
    after: string;
    declaredBy: string;
}
export interface HarmonyPatchOrderItem {
    key: string;
    owner: string;
    index: number;
    before?: string[];
    after?: string[];
}
export declare function orderViolations(order: string[], providers: HarmonyProvider[]): HarmonyOrderViolation[];
export declare function autoSortOrder(order: string[], providers: HarmonyProvider[]): string[];
export declare function patchOrderViolations(order: string[], patches: HarmonyPatchOrderItem[], providers: HarmonyProvider[]): HarmonyOrderViolation[];
export declare function patchOrderInsertionIndex(order: string[], key: string, patches: HarmonyPatchOrderItem[], providers: HarmonyProvider[], defaultRank: ReadonlyMap<string, number>): number;
export declare function autoSortPatchOrder(order: string[], patches: HarmonyPatchOrderItem[], providers: HarmonyProvider[]): string[];
