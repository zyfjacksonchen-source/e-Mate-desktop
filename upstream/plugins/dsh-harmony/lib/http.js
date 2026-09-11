export const JSON_BODY_LIMIT = 1024 * 1024;
export class RequestBodyTooLargeError extends Error {
    constructor() {
        super(`request body exceeds ${JSON_BODY_LIMIT} bytes`);
    }
}
export async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > JSON_BODY_LIMIT) {
            request.resume();
            throw new RequestBodyTooLargeError();
        }
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
}
