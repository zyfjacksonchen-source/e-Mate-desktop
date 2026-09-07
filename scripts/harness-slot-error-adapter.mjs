// Expose the existing pinned SlotCore supervision through SlotsService.
// Both runtime assembly and Desktop materialization apply this same adapter.
export const SLOT_ERROR_PACKAGE = '@deepseek-ai/dsh-client-runtime'
export const SLOT_ERROR_ADAPTER_PATH = 'scripts/harness-slot-error-adapter.mjs'
const OBSERVE = '\t\t\tonEntryError(fn) {\n\t\t\t\treturn this._core.onEntryError(fn);\n\t\t\t}'
const DELEGATE = '\t\t\treportEntryError(key, entry, error, info) {\n\t\t\t\treturn this._core.reportEntryError(key, entry, error, info);\n\t\t\t}'
const HOST = '\t\t\t\t\treportEntryError: (key, entry, error, info) => {\n\t\t\t\t\t\tthis._core.reportEntryError(key, entry, error, info);\n\t\t\t\t\t}'
export function adaptHarnessSlotErrorSource(source) {
  for (const [label, seam] of [['observer', OBSERVE], ['host', HOST]]) {
    const count = source.split(seam).length - 1
    if (count !== 1) throw Error(`Harness slot error adapter expected one rc.7 ${label} seam, found ${count}`)
  }
  if (source.includes(DELEGATE)) throw Error('Harness slot error adapter already applied')
  return source.replace(OBSERVE, `${OBSERVE}\n${DELEGATE}`).replace(HOST, HOST.replace('this._core.reportEntryError', 'this.reportEntryError'))
}
