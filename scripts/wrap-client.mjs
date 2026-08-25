#!/usr/bin/env node
/**
 * Wrap the CJS-compiled client half into a single-file ModuleLoader bundle.
 *
 * The DSH client kernel loads plugin UI through
 * `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`.
 * That `require` is a module-TABLE lookup (platform seeds like `react`,
 * shell-own modules, registered factories) — it does NOT resolve relative
 * paths. We therefore inline every relative require with an object literal
 * of that module's exports, so the emitted bundle has no local requires
 * left (the single-file bundle equivalent of tsdown `alwaysBundle`).
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = '@dsh-external/dsh-oh-my-agent'
const BUILD_DIR = join(ROOT, '.build-client')

let src = readFileSync(join(BUILD_DIR, 'index.js'), 'utf8')

// Inline every relative require: require("./x") -> ({ ...exports of .build-client/x.js })
const REL_RE = /require\(\s*"\.\/([A-Za-z0-9_.-]+)"\s*\)/g
/** Read a tsc-CJS output as CommonJS regardless of package "type". */
function evalCjs(absPath) {
  const code = readFileSync(absPath, 'utf8')
  const module = { exports: {} }
  const fn = new Function(
    'module', 'exports', 'require', '__dirname', '__filename',
    code,
  )
  fn(module, module.exports, require, dirname(absPath), absPath)
  return module.exports
}
let inlined = 0
src = src.replace(REL_RE, (whole, name) => {
  const modPath = join(BUILD_DIR, name + '.js')
  const mod = evalCjs(modPath)
  const keys = Object.keys(mod)
  const literal =
    '({ ' +
    keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(mod[k])}`).join(', ') +
    ' })'
  inlined++
  return literal
})

const banner =
  'window.__ModuleLoader__.load({\n' +
  `\tid: ${JSON.stringify(PLUGIN_ID)},\n` +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n'
const footer = '\n\t\treturn module.exports;\n\t}\n});\n'

const body = src.startsWith('"use strict";')
  ? src.slice('"use strict";'.length)
  : src

const out = banner + body + footer
mkdirSync(join(ROOT, 'lib'), { recursive: true })
writeFileSync(join(ROOT, 'lib/client.js'), out)
console.log(`wrote lib/client.js (${out.length} bytes, ${inlined} local module(s) inlined)`)
