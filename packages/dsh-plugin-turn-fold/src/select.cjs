'use strict'

/**
 * Minimal, faithful subset of the tsquery selector engine the vendored patches
 * rely on: kind names, `[path="value"]` attribute tests, `:has(...)` and comma
 * unions.
 *
 * Why it is re-implemented instead of imported: the vendored provider depends on
 * `@phenomnomnominal/tsquery`, and that package is deliberately NOT a dependency
 * of this repository. The subset below mirrors upstream tsquery 6.2.0 semantics
 * exactly — `getPath`/`getProperties` (dist/src/utils.js, dist/src/traverse.js),
 * the literal attribute comparison (dist/src/matchers/attribute.js) and `has`
 * (dist/src/matchers/has.js) — and was cross-checked against tsquery 6.2.0 on the
 * pinned build; see `docs/2.0.18/dsh-0.1.5-upgrade-facts.md` §77.3.
 *
 * When the provider was still delivered through dsh-harmony this file was only the
 * checker's private helper. It is now the shipped engine as well: `lib/transform.cjs`
 * applies the same three selectors at runtime, so both callers import this single
 * implementation and cannot drift apart.
 *
 * It also owns the bundle identity those selectors were verified against: the pin
 * (`TARGET_BUNDLE_SHA256`) and its evaluation (`sha256`, `evaluateBundleHash`). The
 * build-time checker (`scripts/seams.mjs`) and the runtime driver (`src/transform.cjs`)
 * both refuse a bundle that is not the verified target, through this one constant and
 * this one function.
 *
 * Anything outside that subset throws, so an upstream selector that grows new
 * syntax fails the transform instead of silently matching nothing.
 *
 * One subtlety is load-bearing: tsquery names node kinds through its own
 * `syntaxKindName` table (dist/src/syntax-kind.js), not through the TypeScript
 * enum reverse map. The enum maps alias values — `VariableStatement`,
 * `DebuggerStatement`, `Unknown` — to the range markers `FirstStatement`,
 * `LastStatement`, `FirstToken`, so `VariableStatement:has(...)` would match
 * nothing. The table below reproduces tsquery's resolution exactly.
 */
const { createHash } = require('node:crypto')

const IDENTIFIER_PART = /[A-Za-z0-9_$]/
const WHITESPACE = /\s/

/** @param {*} ts the pinned Harness TypeScript compiler module */
function createSelectorEngine(ts) {
  const syntaxKindNames = new Map()
  for (const name of Object.keys(ts.SyntaxKind).filter(candidate => isNaN(parseInt(candidate, 10)))) {
    const value = ts.SyntaxKind[name]
    if (!syntaxKindNames.has(value)) syntaxKindNames.set(value, name)
  }
  const propertiesCache = new WeakMap()
  const literalParsers = new Map([
    [ts.SyntaxKind.FalseKeyword, () => false],
    [ts.SyntaxKind.NoSubstitutionTemplateLiteral, properties => properties.text],
    [ts.SyntaxKind.NullKeyword, () => null],
    [ts.SyntaxKind.NumericLiteral, properties => +properties.text],
    [ts.SyntaxKind.RegularExpressionLiteral, properties => new RegExp(properties.text)],
    [ts.SyntaxKind.StringLiteral, properties => properties.text],
    [ts.SyntaxKind.TrueKeyword, () => true],
  ])

  function isNode(value) {
    return value !== null && value !== undefined && typeof value.getSourceFile === 'function'
  }

  /** tsquery's synthetic property table for a node. */
  function properties(node) {
    const cached = propertiesCache.get(node)
    if (cached !== undefined) return cached
    const table = {
      kindName: syntaxKindNames.get(node.kind),
      text: node.text !== null && node.text !== undefined ? node.text : node.pos >= 0 ? node.getText() : '',
    }
    if (node.kind === ts.SyntaxKind.Identifier) {
      table.name = node.name !== null && node.name !== undefined ? node.name : table.text
    }
    if (literalParsers.has(node.kind)) table.value = literalParsers.get(node.kind)(table)
    propertiesCache.set(node, table)
    return table
  }

  /** tsquery `getPath`: walk the dotted path through the synthetic property table. */
  function getPath(node, path) {
    let current = node
    for (const key of path.split('.')) {
      if (current === null || current === undefined) return current
      const table = isNode(current) ? properties(current) : {}
      current = key in table ? table[key] : current[key]
    }
    return current
  }

  function splitUnion(text) {
    const parts = []
    let depth = 0
    let quote = null
    let current = ''
    for (const character of text) {
      if (quote !== null) {
        current += character
        if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        current += character
        continue
      }
      if (character === '(' || character === '[') depth += 1
      if (character === ')' || character === ']') depth -= 1
      if (character === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
      current += character
    }
    parts.push(current)
    return parts.map(part => part.trim()).filter(part => part.length > 0)
  }

  function matchingParen(text, open) {
    let depth = 0
    let quote = null
    for (let index = open; index < text.length; index += 1) {
      const character = text[index]
      if (quote !== null) {
        if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) return index
      }
    }
    throw new Error(`unbalanced parentheses in selector: ${text}`)
  }

  function parseAttribute(body, selector) {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'))?$/u.exec(body)
    if (match === null) throw new Error(`unsupported tsquery attribute [${body}] in ${selector}`)
    const value = match[2] !== undefined ? match[2] : match[3]
    return value === undefined ? { path: match[1] } : { path: match[1], value }
  }

  function parseSimple(selector) {
    let index = 0
    while (index < selector.length && WHITESPACE.test(selector[index])) index += 1
    const kindStart = index
    while (index < selector.length && IDENTIFIER_PART.test(selector[index])) index += 1
    const kind = selector.slice(kindStart, index)
    if (kind === '') throw new Error(`unsupported tsquery selector (missing node kind): ${selector}`)
    const attributes = []
    const has = []
    for (;;) {
      while (index < selector.length && WHITESPACE.test(selector[index])) index += 1
      if (index >= selector.length) break
      if (selector[index] === '[') {
        const end = selector.indexOf(']', index)
        if (end === -1) throw new Error(`unbalanced attribute in selector: ${selector}`)
        attributes.push(parseAttribute(selector.slice(index + 1, end).trim(), selector))
        index = end + 1
        continue
      }
      if (selector.startsWith(':has(', index)) {
        const end = matchingParen(selector, index + 4)
        for (const inner of splitUnion(selector.slice(index + 5, end))) has.push(parseSimple(inner))
        index = end + 1
        continue
      }
      throw new Error(`unsupported tsquery selector syntax ${JSON.stringify(selector.slice(index))} in ${selector}`)
    }
    return { kind, attributes, has }
  }

  function children(node) {
    try {
      return node.getChildren()
    } catch {
      const collected = []
      node.forEachChild(child => collected.push(child))
      return collected
    }
  }

  function visit(node, iterator) {
    iterator(node)
    for (const child of children(node)) visit(child, iterator)
  }

  function matches(node, simple) {
    if (syntaxKindNames.get(node.kind) !== simple.kind) return false
    for (const attribute of simple.attributes) {
      const value = getPath(node, attribute.path)
      if (value === undefined) return false
      if (attribute.value === undefined) {
        if (value === null) return false
        continue
      }
      if (attribute.value !== `${value}`) return false
    }
    for (const inner of simple.has) {
      let found = false
      visit(node, candidate => {
        if (!found && matches(candidate, inner)) found = true
      })
      if (!found) return false
    }
    return true
  }

  /** Evaluate a selector over a source file, mirroring `tsquery(ast, selector)`. */
  function query(ast, selector) {
    const simples = splitUnion(selector).map(parseSimple)
    const found = []
    visit(ast, node => {
      for (const simple of simples) {
        if (matches(node, simple)) {
          found.push(node)
          return
        }
      }
    })
    return found
  }

  return { getPath, parseSimple, query, splitUnion }
}

/**
 * sha256 of the compiled ui-chat bundle the vendored patches were verified against.
 *
 * This is the identity of the only bundle the patches may touch, and it lives here - in the
 * one module both the build-time checker and the runtime driver import - so the two gates
 * cannot disagree about which bytes are authorized. It is pinned deliberately rather than
 * computed at run time: a Harness rebuild that changes the compiled shape must first
 * re-verify the three selectors by hand, and only then may this value move.
 *
 * The file size is reported by the checker but deliberately not asserted: the digest is the
 * identity, and a second numeric pin would only be one more thing to disagree with it.
 */
const TARGET_BUNDLE_SHA256 = 'cf53ae8f5978901504286189a64506febf09cd237d097db3abf3f39b3953ba97'

/** The digest the seams were verified against on Windows, where the same source builds a different bundle. */
const WINDOWS_BUNDLE_SHA256 = '9a54fa521480db27bf10857622c87ba05ad508e278ad349114294bfb02f8db7b'

/**
 * Digests of the e-Mate-*assembled* product bundles, one entry per platform.
 *
 * The Profile does not serve the pinned checkout verbatim. While the Desktop client closure is
 * assembled, scripts/harness-conversation-adapter.mjs rewrites this same
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js` (harness-provenance.mjs:412-417), and that
 * adapted file is what the Web server actually serves. Refusing it would mean the provider can
 * never apply in the shipped product, so the assembled bundle is authorized as well - but only
 * after the three selectors and the six host symbols were re-verified against its bytes, the same
 * hand check the pinned family above requires. Measured on this checkout with
 * `evaluateSeams`/`evaluateHostSymbols` (see docs/2.0.18/turn-fold-mount.md): all three selectors
 * match exactly once (lines 2230 / 2693 / 8445) and all six symbols resolve.
 *
 * A digest moves here only after that re-verification, exactly like the pinned family.
 */
const ASSEMBLED_BUNDLE_SHA256 = Object.freeze([
  'f86778689ec9dff029995e5584f4c1ffab2bd291761dadd4cca9f5d7791a732e', // darwin assembly, 380708 bytes
])

/** Every digest the seams were verified against, one entry per platform. A bundle matching none is refused. */
const VERIFIED_BUNDLE_SHA256 = Object.freeze([
  TARGET_BUNDLE_SHA256,
  WINDOWS_BUNDLE_SHA256,
  ...ASSEMBLED_BUNDLE_SHA256,
])

/** Identifier of the bundle-digest gate, reported beside the selector checks. */
const BUNDLE_HASH_CHECK_ID = 'verify-bundle-hash'

/**
 * Hash the bytes a caller resolved against the pin above.
 * @param {Buffer|string} value the bundle bytes, or the bundle text.
 * @returns {string} the lowercase hex sha256 digest.
 */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Compare a resolved bundle digest against the pin, in the same result shape the selector
 * checks use, so the gate is rendered and reported exactly like they are.
 *
 * Pure on purpose: it takes two digests and touches no filesystem, so each caller keeps its
 * own file identity and its own diagnostic. A mismatch is a refusal, and both callers honour
 * it the same way: the checker evaluates no selector and the driver applies no patch.
 *
 * @param {string} actualSha256 digest of the bundle a caller resolved
 * @param {string|readonly string[]} pinnedSha256 the digest, or the set of digests, that bundle may
 *   have; defaults to every digest the seams were verified against
 * @returns {{ result: {id: string, ok: boolean, found: number, expect: number, detail: string}, failures: string[] }}
 */
function evaluateBundleHash(actualSha256, pinnedSha256 = VERIFIED_BUNDLE_SHA256) {
  const accepted = Array.isArray(pinnedSha256) ? pinnedSha256 : [pinnedSha256]
  const ok = accepted.includes(actualSha256)
  const detail = ok
    ? `resolved sha256 ${actualSha256} is the verified target`
    : `resolved sha256 ${actualSha256} is not the verified target (accepted ${accepted.join(', ')})`
  const result = { id: BUNDLE_HASH_CHECK_ID, ok, found: ok ? 1 : 0, expect: 1, detail }
  return { result, failures: ok ? [] : [`${BUNDLE_HASH_CHECK_ID}: ${detail}`] }
}

module.exports = {
  ASSEMBLED_BUNDLE_SHA256,
  BUNDLE_HASH_CHECK_ID,
  TARGET_BUNDLE_SHA256,
  VERIFIED_BUNDLE_SHA256,
  WINDOWS_BUNDLE_SHA256,
  createSelectorEngine,
  evaluateBundleHash,
  sha256,
}
