/**
 * Build the client bundle from `client/src/*.js`.
 *
 * The host serves exactly one browser bundle per plugin, in the lazy-CJS format
 * `window.__ModuleLoader__.load({ id, factory })`. Inside that factory a relative
 * `require` cannot resolve — the loader's table holds only platform modules and
 * boot-graph rows — so splitting the client across files would normally mean
 * adopting a real bundler and its config, plugins, and upgrade treadmill.
 *
 * It does not: the parts need no module isolation, only concatenation into one
 * closure. That is all this script does, which keeps the client maintainable
 * without a build toolchain to maintain.
 *
 * Run:  node tools/build-client.mjs
 * Used: tools/client-selftest.mjs imports `buildBundle` to prove the committed
 *       bundle matches the parts, so a forgotten rebuild fails the suite rather
 *       than silently shipping stale client code.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'client', 'src')
const OUT_FILE = join(ROOT, 'client', 'client.js')
const PACKAGE_ID = 'dsh-novel'

/** Concatenate the parts into the bundle text. Throws on anything invalid. */
export function buildBundle() {
  const parts = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()

  if (parts.length === 0) throw new Error(`no parts found in ${SRC_DIR}`)

  const bodies = []
  for (const name of parts) {
    const text = readFileSync(join(SRC_DIR, name), 'utf8')

    // A part is a factory-body fragment, not a module. An import/export here
    // would be a syntax error only once concatenated — at plugin load time in
    // the browser, far from the edit that caused it. Catch it here instead.
    if (/^\s*import\s/m.test(text)) throw new Error(`${name} uses \`import\`; parts are concatenated into one closure`)
    if (/^\s*export\s/m.test(text)) throw new Error(`${name} uses \`export\`; parts are concatenated into one closure`)

    bodies.push(`      // ==== ${name} ${'='.repeat(Math.max(2, 66 - name.length))}\n${text.trimEnd()}\n`)
  }

  const bundle = `/**
 * GENERATED FILE — do not edit.
 *
 * Built from client/src/*.js by tools/build-client.mjs; edit those parts and
 * re-run the build. Hand edits here are lost on the next build.
 *
 * Loaded by the host's client module system: running this script only registers
 * the factory below, and its module body runs at first materialization. The
 * platform module table supplies \`require\` values, so \`react\` is the host's own
 * copy rather than a second one.
 */
window.__ModuleLoader__.load({
  id: '${PACKAGE_ID}',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

${bodies.join('\n')}
    exports.name = '${PACKAGE_ID}'
    exports.inject = ['slots', 'layout']
    exports.apply = apply
    return module.exports
  },
})
`

  // Compiling is the cheapest real check that concatenation produced valid
  // JavaScript: `new Function` parses without executing, and rejects top-level
  // import/export for free.
  // eslint-disable-next-line no-new-func
  new Function(bundle)

  return { bundle, parts }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  try {
    const { bundle, parts } = buildBundle()
    writeFileSync(OUT_FILE, bundle, 'utf8')
    console.log(`built ${OUT_FILE}`)
    console.log(`  ${parts.length} parts, ${bundle.split('\n').length} lines, ${Buffer.byteLength(bundle)} bytes`)
    console.log(`  parts: ${parts.join(', ')}`)
  } catch (error) {
    console.error(`build-client: ${error.message}`)
    process.exit(1)
  }
}
