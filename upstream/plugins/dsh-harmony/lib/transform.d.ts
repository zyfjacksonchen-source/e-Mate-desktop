import ts from 'typescript';
import { type Selector } from '@phenomnomnominal/tsquery';
import type { HarmonySemanticPatch, HarmonySourcePatch } from './index.js';
export interface PatchIdentity {
    key: string;
    owner: string;
    declaration: string;
    fingerprint?: string;
}
export interface BoundSemanticPatch<T extends PatchIdentity = PatchIdentity> {
    registered: T;
    patch: HarmonySemanticPatch;
}
export interface BoundSourceTrace<T extends PatchIdentity = PatchIdentity> {
    registered: T;
    patch: HarmonySourcePatch;
}
export declare function parseSource(filename: string, source: string): ts.SourceFile;
export interface SourceDelta {
    start: number;
    removed: number;
    inserted: string;
}
export declare function sourceDelta(before: string, after: string): SourceDelta;
export declare function applySourceDelta(source: string, delta: SourceDelta): string;
interface QueryAttribute {
    name: string;
    value: unknown;
}
interface QuerySegment {
    selector: Selector;
    kinds?: ts.SyntaxKind[];
    attributes: QueryAttribute[];
}
interface QueryBranch {
    key: string;
    selector: Selector;
    segments?: QuerySegment[];
    merkleSafe: boolean;
}
interface QueryDependencies {
    ancestors: boolean;
    siblings: boolean;
    childPosition: boolean;
    siblingCount: boolean;
    source: boolean;
}
interface QueryPlan {
    key: string;
    selector: Selector;
    branches: QueryBranch[];
    indexable: boolean;
    sourceFile: boolean;
    dependencies: QueryDependencies;
    observedProperties: string[];
}
interface MatchLocator {
    kind: ts.SyntaxKind;
    pos: number;
    end: number;
    occurrence: number;
}
declare class AstIndex {
    sourceFile: ts.SourceFile;
    private readonly known;
    private readonly byKind;
    private readonly cleanedGeneration;
    private readonly dirtyKinds;
    private readonly merkleHashes;
    private generation;
    private updating;
    constructor(sourceFile: ts.SourceFile);
    update(sourceFile: ts.SourceFile): void;
    query(plan: QueryPlan, root?: ts.Node): ts.Node[];
    resolve(locators: ReadonlyArray<MatchLocator>): ts.Node[];
    private nodes;
    private addNewNodes;
    private queryBranch;
    private segmentCandidates;
    private queryMerkleBranch;
    private merkleHash;
    private queryAutomaton;
    private automatonContext;
}
export interface SourceAst {
    sourceFile: ts.SourceFile;
    index?: AstIndex;
    fingerprint: string;
    incremental?: boolean;
}
export declare function applySourcePatch(filename: string, target: string, source: string, original: string, registered: PatchIdentity, patch: HarmonySourcePatch, history: ReadonlyArray<{
    owner: string;
}>, historySources: () => ReadonlyArray<{
    owner: string;
    source: string;
}>, previousSourceAst?: SourceAst, previousDelta?: SourceDelta): {
    source: string;
    matches: number;
    sourceAst: SourceAst;
    delta: SourceDelta;
};
export declare function instrumentSourceTraces<T extends PatchIdentity>(filename: string, source: string, target: {
    package: string;
    file: string;
}, patches: BoundSourceTrace<T>[]): string;
export declare function semanticMatchCount(filename: string, source: string, target: string, functionName: string, registered: PatchIdentity, patch: HarmonySemanticPatch): number;
export declare function assertNoReplaceConflict<T extends PatchIdentity>(functionName: string, registered: BoundSemanticPatch<T>[]): void;
export declare function instrumentSemantic(filename: string, source: string, target: string, functionName: string, registered: PatchIdentity, patch: HarmonySemanticPatch, bindingKey: string): {
    source: string;
    matches: number;
    bindingKey: string;
};
export {};
