import type { Readable } from 'node:stream';
export declare const JSON_BODY_LIMIT: number;
export declare class RequestBodyTooLargeError extends Error {
    constructor();
}
export declare function readJson<T = unknown>(request: Readable): Promise<T>;
