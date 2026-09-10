export const FS_BYTES_PACKAGE = '@deepseek-ai/dsh-fs-local'
export const FS_BYTES_ADAPTER_PATH = 'scripts/harness-fs-bytes-adapter.mjs'

// An owner-local replacement for 0.1.5 readWholeBytes, not another FS API.
// Binary reads (including read_image) deliberately reject multiply linked files:
// a workspace path must not silently grant publication of an outside hardlink.
function readWholeBytesSource() {
  return `async function readWholeBytes(target, signal, maxBytes, internals = {}) {
\tthrowIfAborted(signal, "read");
\tconst before = await probe(target.targetKey);
\tif (!before) throw new FsError("cannot read file: not found", "FS_NOT_FOUND");
\tif (before.type !== "file") throw new FsError("cannot read file: not a regular file", "FS_NOT_REGULAR_FILE");
\tif (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || before.size > maxBytes) throw new FsError("file exceeds the binary-read limit", "FS_TOO_LARGE");
\tawait internals.inspectReadBytesAfterStat?.(target);
\tthrowIfAborted(signal, "read");
\tconst flags = emateReadConstants.O_RDONLY | (process.platform === "win32" ? 0 : ((emateReadConstants.O_NOFOLLOW ?? 0) | (emateReadConstants.O_NONBLOCK ?? 0)));
\tconst handle = await open(target.targetKey, flags);
\ttry {
\t\tthrowIfAborted(signal, "read");
\t\tconst opened = await handle.stat({ bigint: true });
\t\tif (!opened.isFile()) throw new FsError("cannot read file: not a regular file", "FS_NOT_REGULAR_FILE");
\t\tif (opened.nlink !== 1n) throw new FsError("binary reads of hard-linked files are not permitted; use an independent copy", "FS_PERMISSION_DENIED");
\t\tif (versionOf(opened) !== before.version) throw new FsError("file changed before binary read", "FS_STALE_VERSION");
\t\tconst chunks = [];
\t\tlet bytes = 0;
\t\twhile (true) {
\t\t\tthrowIfAborted(signal, "read");
\t\t\tconst buffer = Buffer.allocUnsafe(Math.min(65536, maxBytes - bytes + 1));
\t\t\tconst result = await handle.read(buffer, 0, buffer.length, null);
\t\t\tthrowIfAborted(signal, "read");
\t\t\tif (result.bytesRead === 0) break;
\t\t\tbytes += result.bytesRead;
\t\t\tif (bytes > maxBytes) throw new FsError("file exceeds the binary-read limit", "FS_TOO_LARGE");
\t\t\tchunks.push(buffer.subarray(0, result.bytesRead));
\t\t}
\t\tconst after = await handle.stat({ bigint: true });
\t\tthrowIfAborted(signal, "read");
\t\tif (after.nlink !== 1n || versionOf(after) !== before.version || BigInt(bytes) !== opened.size) throw new FsError("file changed during binary read", "FS_STALE_VERSION");
\t\treturn Buffer.concat(chunks, bytes);
\t} finally {
\t\tawait handle.close();
\t}
}`
}

export function adaptHarnessFsBytesSource(source) {
  const begin = 'async function readWholeBytes(target, signal, maxBytes, internals = {}) {'
  // Only the opening line must be globally unique: it identifies the function.
  // The end marker is resolved from `start` below, so an identical ending in a
  // neighbouring function must not reject an unambiguous seam.
  const ending = '\treturn Buffer.concat(chunks, bytes);\n}'
  if (source.split(begin).length !== 2
    || !source.includes('\tconst info = await statRegularFile(target, "read", signal);\n')) {
    throw new Error('Harness binary-read adapter expected one unmodified readWholeBytes seam')
  }
  const imports = 'import { createReadStream } from "node:fs";'
  if (source.split(imports).length !== 2) throw new Error('Harness binary-read adapter expected one 0.1.5 node:fs import')
  source = source.replace(imports, 'import { createReadStream, constants as emateReadConstants } from "node:fs";')
  const start = source.indexOf(begin)
  const end = source.indexOf(ending, start) + ending.length
  if (end <= start) throw new Error('Harness binary-read adapter missing end of 0.1.5 readWholeBytes')
  const original = source.slice(start, end)
  if (!original.includes('createReadStream(target.targetKey, {') || !original.includes('await internals.inspectReadBytesAfterStat?.(target);')) {
    throw new Error('Harness binary-read adapter 0.1.5 readWholeBytes has drifted')
  }
  return source.slice(0, start) + readWholeBytesSource() + source.slice(end)
}
