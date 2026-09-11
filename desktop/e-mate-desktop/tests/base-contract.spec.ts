import { describe, expect, it } from 'vitest'
import { parseProfileBaseContract } from '../src/base-contract.ts'

function contract(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'e-mate-desktop-profile-v18-dsh-43c411a51c55',
    desktop_reference: {
      repository: 'anywhere-labs/deepseek-harness-desktop',
      commit: '166c16cfc38c51d32c2316715548c0f8271db517',
      harness_repository: 'deepseek-ai/deepseek-harness',
      harness_commit: '183f08e9c6dde7e36cd2318eaee70b0da08fb35e',
      harness_version: '0.1.5-rc.1',
    },
    harness_version: '0.1.5-rc.1',
    harness_commit: '43c411a51c555e61e9b5f500442cb3404a2d70cd',
    runtime_imports: {
      '@deepseek-ai/dsh-settings': '0.1.5-rc.1',
      '@e-mate/desktop/vision-toolkit': '2.0.18',
      react: '18.3.1',
    },
  }
}

describe('Desktop Base contract', () => {
  it('accepts the exact pinned contract shape', () => {
    expect(parseProfileBaseContract(contract())).toMatchObject({
      schema_version: 1,
      harness_version: '0.1.5-rc.1',
      harness_commit: '43c411a51c555e61e9b5f500442cb3404a2d70cd',
      runtime_imports: expect.objectContaining({ '@e-mate/desktop/vision-toolkit': '2.0.18' }),
    })
  })

  it('rejects extra fields and rc drift', () => {
    expect(parseProfileBaseContract({ ...contract(), extra: true })).toBeUndefined()
    expect(parseProfileBaseContract({ ...contract(), harness_version: '0.1.0-rc.8' })).toBeUndefined()
  })
})
