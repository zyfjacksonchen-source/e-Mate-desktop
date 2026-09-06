import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib'
import test from 'node:test'
import { decodedContentLength } from '../src/profile/http-response.ts'

test('real Fetch keeps encoded length while returning decoded gzip, br and deflate bodies', async () => {
  const original = Buffer.from(JSON.stringify({ result: '测试内容'.repeat(256) }))
  const codecs = { gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync, identity: value => value }
  const server = createServer((request, response) => {
    const encoding = request.url.slice(1)
    const encoded = codecs[encoding](original)
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': encoded.length })
    response.end(encoded)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    for (const encoding of Object.keys(codecs)) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${encoding}`)
      assert.equal(response.headers.get('content-length'), String(codecs[encoding](original).length))
      assert.equal(decodedContentLength(response), encoding === 'identity' ? String(original.length) : null)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), original)
    }
    assert.equal(decodedContentLength(new Response('abc', { headers: { 'content-length': '3' } })), '3')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
