/**
 * picomatch-lite: a small glob engine for the rules engine.
 *
 * Supports the subset OmO rules rely on: `**`, `*`, `?`, `{a,b}` alternation,
 * character classes `[abc]`, and `!`-prefixed negation. `matchGlob(pattern,
 * path)` decides whether a (posix, relative) file path satisfies a pattern.
 */

export function globToRegExp(glob: string): RegExp {
  let re = '^'
  let i = 0
  const src = glob
  while (i < src.length) {
    const ch = src[i]
    if (ch === '*') {
      if (src[i + 1] === '*') {
        // `**` — match across directory separators (including none)
        if (src[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      re += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    if (ch === '{') {
      const end = src.indexOf('}', i)
      if (end !== -1) {
        const inner = src.slice(i + 1, end)
        const alts = inner.split(',').map((alt) => escapeRe(alt))
        re += '(?:' + alts.join('|') + ')'
        i = end + 1
        continue
      }
    }
    if (ch === '[') {
      const end = src.indexOf(']', i)
      if (end !== -1) {
        re += src.slice(i, end + 1)
        i = end + 1
        continue
      }
    }
    re += escapeRe(ch)
    i += 1
  }
  re += '$'
  return new RegExp(re)
}

function escapeRe(ch: string): string {
  return /[.+^$()|\\]/.test(ch) ? '\\' + ch : ch
}

/** Match one glob against a posix path (no leading './', no trailing '/' on dirs). */
export function matchGlob(glob: string, relPath: string): boolean {
  const negate = glob.startsWith('!')
  const body = negate ? glob.slice(1) : glob
  const re = globToRegExp(body)
  const hit = re.test(relPath)
  return negate ? !hit : hit
}

/**
 * Default matching semantics for a rule with a `globs` array: a rule applies
 * when ANY glob matches the target path. Negation globs are tested too but a
 * single positive hit wins; use ordering in the glob array for nuance.
 */
export function matchAnyGlob(globs: string[], relPath: string): boolean {
  if (!globs || globs.length === 0) return true
  let negated = false
  for (const g of globs) {
    const isNeg = g.startsWith('!')
    const hit = matchGlob(g, relPath)
    if (isNeg) {
      if (hit) negated = true
    } else if (hit) {
      return true
    }
  }
  return !negated
}
