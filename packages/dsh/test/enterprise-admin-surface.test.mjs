import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The enterprise admin app lists a selection that can grow past the viewport. The list must
// keep its own bounded scroll area, otherwise a large selection pushes the bulk policy
// controls out of reach, which is the regression the ledger records.
const app = readFileSync(fileURLToPath(new URL('../../../enterprise/apps/admin/src/App.tsx', import.meta.url)), 'utf8')

test('the bulk selection list stays bounded so the policy controls remain reachable', () => {
  const list = /<ul[^>]*aria-live='polite'[^>]*>/u.exec(app)
  assert.notEqual(list, null, 'the announced selection list disappeared')
  assert.match(list[0], /maxHeight/u, 'the selection list lost its height bound')
  assert.match(list[0], /overflowY:\s*'auto'/u, 'the bounded list no longer scrolls')
})

test('the bulk policy fields stay a flat, reachable fieldset', () => {
  assert.match(app, /className='modal-fields'/u, 'the bulk policy fieldset disappeared')
  assert.match(app, /minWidth:\s*0/u, 'the fieldset lost its min-width reset and can overflow the modal')
})
