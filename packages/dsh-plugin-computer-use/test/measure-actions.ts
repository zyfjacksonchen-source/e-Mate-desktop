/** Report-only timing support for the main agent's real native Tool acceptance.
 * Call after warming the existing provider. `runAndVerify` must execute the
 * existing Tool and verify the fixture result plus focus/cursor/clipboard
 * monitor; this utility neither creates a provider nor grants authorization.
 * No failed or slow sample is discarded. Persist the returned raw samples
 * alongside the real machine/Tool/monitor evidence outside source control.
 */
export async function measureActions(runAndVerify: (sample: number) => Promise<boolean>, count = 30) {
  if (!Number.isSafeInteger(count) || count < 30 || count > 300) throw new Error('measurement requires 30 to 300 samples')
  const samples: Array<{ sample: number; durationMs: number; verified: boolean; errorCode?: string }> = []
  for (let sample = 0; sample < count; sample += 1) {
    const started = performance.now()
    try {
      const verified = await runAndVerify(sample)
      samples.push({ sample, durationMs: performance.now() - started, verified: verified === true })
    } catch {
      samples.push({ sample, durationMs: performance.now() - started, verified: false, errorCode: 'ACTION_OR_VERIFICATION_FAILED' })
    }
  }
  const times = samples.map(sample => sample.durationMs).sort((left, right) => left - right)
  return {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    sampleCount: count,
    verifiedCount: samples.filter(sample => sample.verified).length,
    p50Ms: times[Math.ceil(count * 0.5) - 1],
    p95Ms: times[Math.ceil(count * 0.95) - 1],
    maxMs: times[count - 1],
    samples,
  }
}
