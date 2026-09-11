/**
 * Minimal, faithful subset of the tsquery selector engine the vendored patches
 * rely on: kind names, `[path="value"]` attribute tests, `:has(...)` and
 * comma unions.
 *
 * Why it is re-implemented instead of imported: the vendored Harmony provider
 * depends on `@phenomnomnominal/tsquery`, and that package is deliberately NOT a
 * dependency of this repository. The subset below mirrors upstream tsquery 6.2.0
 * semantics exactly — `getPath`/`getProperties` (dist/src/utils.js,
 * dist/src/traverse.js), the literal attribute comparison
 * (dist/src/matchers/attribute.js) and `has` (dist/src/matchers/has.js) — and was
 * cross-checked against tsquery 6.2.0 on the pinned build; see
 * `docs/2.0.18/dsh-0.1.5-upgrade-facts.md` §76.
 *
 * Anything outside that subset throws, so an upstream selector that grows new
 * syntax fails the build instead of silently matching nothing.
 *
 * One subtlety is load-bearing: tsquery names node kinds through its own
 * `syntaxKindName` table (dist/src/syntax-kind.js), not through the TypeScript
 * enum's reverse map. The enum maps alias values — `VariableStatement`,
 * `DebuggerStatement`, `Unknown` — to the range markers `FirstStatement`,
 * `LastStatement`, `FirstToken`, so `VariableStatement:has(...)` would match
 * nothing. The table below reproduces tsquery's resolution exactly.
 */

const IDENTIFIER_PART = /[A-Za-z0-9_$]/
const WHITESPACE = /\s/

/** @param {*} ts the pinned Harness TypeScript compiler module */
export function createSelectorEngine(ts) {
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
