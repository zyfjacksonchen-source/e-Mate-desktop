// Historical evidence is parsed under its original identity and cannot close a current gate.
export const RELEASE_VERSION = '2.0.18'
const RELEASES = Object.freeze({ '2.0.17': 'EM217', '2.0.18': 'EM218' })

export function ticketFor(version, suffix) {
  const prefix = RELEASES[version]
  if (prefix === undefined) throw new Error('unsupported image evidence release version')
  return `${prefix}-${suffix}`
}

export function versionFor(ticket, suffix) {
  const version = Object.keys(RELEASES).find(version => ticketFor(version, suffix) === ticket)
  if (version === undefined) throw new Error('unsupported image evidence ticket identity')
  return version
}

export function minimumQualityPairs(version) {
  ticketFor(version, '503')
  return version === RELEASE_VERSION ? 30 : 50
}

export function imageModelFor(version) {
  ticketFor(version, '502')
  return version === RELEASE_VERSION ? 'gpt-image-2.5-flare' : 'gpt-image-2-pro'
}
