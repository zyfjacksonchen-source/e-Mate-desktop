import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The deployment artifacts are a matched pair: the guide tells an operator which patches
// to apply, and the image wrapper patch is what keeps the OAuth Responses outer model
// separate from the image tool model. Editing one without the other silently deploys a
// wrapper that rewrites the image model, which is the failure the ledger records.
const deployRoot = fileURLToPath(new URL('../../../enterprise/deploy/', import.meta.url))
const guide = readFileSync(join(deployRoot, 'gpt-fast-mode.md'), 'utf8')

test('the fast-mode guide names patches that exist', () => {
  for (const name of ['sub2api-fast-mode.patch', 'sub2api-image-wrapper.patch']) {
    assert.ok(guide.includes(name), 'the guide no longer names ' + name)
    assert.ok(existsSync(join(deployRoot, name)), name + ' is missing from enterprise/deploy')
  }
})

test('the image wrapper keeps the image model and only moves the outer model', () => {
  const patch = readFileSync(join(deployRoot, 'sub2api-image-wrapper.patch'), 'utf8')
  assert.match(patch, /gpt-5\.6-luna/u, 'the wrapper no longer sets the OAuth Responses outer model')
  assert.match(patch, /gpt-image-2\.5-flare/u, 'the wrapper no longer keeps the channel-mapped image model')
  // The receipt assertions are what prove the image model was not rewritten upstream.
  assert.match(patch, /result\.Model/u)
  assert.match(patch, /result\.UpstreamModel/u)
})
