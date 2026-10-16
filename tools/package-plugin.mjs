/**
 * Package the plugin as something that can be installed anywhere.
 *
 * WHY NOT `npm pack`. There is no npm or pnpm on this machine (recorded in the host-patch notes: the DSH source
 * tree is not here either), and a plugin that can only be packaged on a machine with a package manager is a
 * plugin that cannot be packaged here at all. A `.tgz` is a gzipped tar, tar is a documented 512-byte-header
 * format, and `node:zlib` is built in — so this writes the archive itself, with no subprocess and no dependency.
 * That also makes it READABLE: the verification below extracts and loads what it just wrote, which a wrapper
 * around an external tool could not do as convincingly.
 *
 * WHAT IT REFUSES TO DO:
 *   - package a tree whose test suites fail          (`--force` to override, and it says so loudly)
 *   - package a tree with an absolute path baked in   (works here, breaks on the next machine)
 *   - package a declared entry point that does not exist
 *   - package a relative import that does not resolve
 * Those four are the ways a plugin "packages fine" and then fails to load somewhere else.
 *
 * Usage:
 *   node tools/package-plugin.mjs              write the archive and verify it
 *   node tools/package-plugin.mjs --force      skip the test suites
 *   node tools/package-plugin.mjs --out <dir>  write somewhere else
 */
import { gzipSync, gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
const outAt = argv.indexOf('--out')
const OUT_DIR = outAt === -1 ? ROOT : resolve(argv[outAt + 1] ?? ROOT)

let failed = 0
const note = (text) => console.log(`  ${text}`)
const bad = (text) => {
  failed += 1
  console.log(`  ✗ ${text}`)
}

// ---------------------------------------------------------------------------
// 1. The suites. A package is a release, and a release of a red tree is a bug
//    report waiting to happen.
// ---------------------------------------------------------------------------

const SUITES = ['impl-selftest.mjs', 'api-selftest.mjs', 'client-selftest.mjs']
if (FORCE) {
  note('--force: skipping the test suites (the archive may be broken)')
} else {
  note('running the suites before packaging…')
  for (const suite of SUITES) {
    // AS A CHILD, NOT AN IMPORT. Each suite ends with `process.exit`, so importing one would end THIS process —
    // the first version of this gate would have exited 0 before writing anything, which is worse than no gate.
    // `stdio: 'inherit'` rather than a pipe: piping a child's output is blocked in this sandbox, and the suites'
    // own summaries are worth reading anyway.
    const result = spawnSync(process.execPath, [join(ROOT, 'tools', suite)], { cwd: ROOT, stdio: 'inherit' })
    if (result.status !== 0) {
      console.log(`\nFAIL  ${suite} exited ${result.status}; refusing to package a red tree.`)
      console.log('      Use --force only if you know what you are shipping.')
      process.exit(1)
    }
  }
}

// ---------------------------------------------------------------------------
// 2. What goes in. Declared, never inferred — an inferred list ships .verify/,
//    node_modules/ and yesterday's scratch file.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// SHIPPED, DECLARED: the host half, the built client bundle, the patch manifest, the design note. Not `tools/`
// (dev-only) and not the host-bug history (it describes THIS machine's asar), which is exactly the sort of thing
// an inferred list would have swept in.
const INCLUDED = ['package.json', 'lib', 'client/client.js', 'cordis.patch.yml', 'README.md', 'docs/data-model.md']

/** Every file in the package, as POSIX-style paths relative to the root. */
function collect() {
  const files = []
  const walk = (absolute, base) => {
    const stat = statSync(absolute)
    if (stat.isFile()) {
      files.push(base)
      return
    }
    for (const entry of readdirSync(absolute).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      walk(join(absolute, entry), `${base}/${entry}`)
    }
  }
  for (const entry of INCLUDED) {
    const absolute = join(ROOT, entry)
    if (!existsSync(absolute)) {
      bad(`declared entry "${entry}" does not exist`)
      continue
    }
    walk(absolute, entry)
  }
  return files.sort()
}

// ---------------------------------------------------------------------------
// 3. Portability. The four ways a tree packages fine and fails to load elsewhere.
// ---------------------------------------------------------------------------

const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt'])

function audit(files) {
  const absolutePattern = /(?:[A-Za-z]:\\|D:\\dsh-home|\/Users\/|\/home\/[a-z])/
  for (const file of files) {
    if (!TEXT.has(file.slice(file.lastIndexOf('.')))) continue
    const text = readFileSync(join(ROOT, file), 'utf8')
    // Documents about this machine are allowed to name it; CODE that names it cannot run elsewhere.
    if (file.startsWith('docs/') || file === 'README.md') continue
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (!absolutePattern.test(line)) continue
      // A comment recording where something was measured is documentation, not a dependency — but only when it
      // is a comment. A path in live code is the failure this check exists for.
      const trimmed = line.trim()
      const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')
      if (isComment) continue
      bad(`${file}:${index + 1} bakes in an absolute path: ${trimmed.slice(0, 90)}`)
    }
  }
}

/** Every relative import in the host half must resolve, or the package is missing a file. */
function auditImports(files) {
  const jsFiles = files.filter((file) => file.startsWith('lib/') && file.endsWith('.js'))
  for (const file of jsFiles) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    for (const match of text.matchAll(/from\s+'(\.[^']*)'/g)) {
      const target = resolve(ROOT, dirname(file), match[1])
      if (!existsSync(target)) bad(`${file} imports ${match[1]}, which does not exist`)
    }
  }
  return jsFiles.length
}

/** The entry points `package.json` promises, and the client bundle's size. */
function auditManifest() {
  for (const [label, value] of [
    ['main', pkg.main],
    ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
    ['dsh.client', pkg.dsh?.client === undefined ? null : 'set'],
  ]) {
    if (value === null || value === undefined || value === '') bad(`package.json declares no ${label}`)
  }
  for (const [label, value] of [['main', pkg.main], ['dsh.bundle.patch', pkg.dsh?.bundle?.patch]]) {
    if (typeof value === 'string' && !existsSync(join(ROOT, value))) bad(`${label} points at ${value}, which does not exist`)
  }
  const client = join(ROOT, 'client', 'client.js')
  if (!existsSync(client)) bad('client/client.js has not been built')
  else if (statSync(client).size < 10_000) bad(`client/client.js is only ${statSync(client).size} bytes — did the build fail?`)
  if (pkg.dsh?.client?.platform !== 'web') bad('dsh.client.platform must be "web" for this host')
}

// ---------------------------------------------------------------------------
// 4. A tar writer. 512-byte headers, per the ustar format; then gzip.
// ---------------------------------------------------------------------------

function tarHeader(name, size) {
  const header = Buffer.alloc(512)
  const write = (text, offset, length) => header.write(text, offset, length, 'utf8')
  if (Buffer.byteLength(name, 'utf8') > 100) throw new Error(`tar name too long (${name}); use the prefix field or rename`)
  write(name, 0, 100)
  write('0000644', 100, 8) // mode
  write('0000000', 108, 8) // uid
  write('0000000', 116, 8) // gid
  write(size.toString(8).padStart(11, '0'), 124, 12)
  write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136, 12) // mtime
  write('        ', 148, 8) // checksum: spaces while it is computed
  write('0', 156, 1) // typeflag: regular file
  write('ustar', 257, 6)
  write('00', 263, 2)
  write('root', 265, 32)
  write('root', 297, 32)
  let sum = 0
  for (const byte of header) sum += byte
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return header
}

function makeTar(entries, prefix) {
  const blocks = []
  for (const entry of entries) {
    const name = `${prefix}/${entry.path}`
    blocks.push(tarHeader(name, entry.content.length), entry.content)
    const remainder = entry.content.length % 512
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder))
  }
  // Two zero blocks end an archive, and tar readers are entitled to be strict about it.
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** Read an archive back. Used by the verification, so it is the reader that proves the writer. */
function readTar(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim() || '0', 8)
    const content = buffer.subarray(offset + 512, offset + 512 + size)
    // The checksum is the one field that makes a tar self-verifying, so it is checked on the way back in.
    const declared = parseInt(header.toString('utf8', 148, 156).replace(/\0.*$/, '').trim() || '0', 8)
    const copy = Buffer.from(header)
    copy.fill(32, 148, 156)
    let sum = 0
    for (const byte of copy) sum += byte
    entries.push({ name, size, content, checksumOk: sum === declared })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

// ---------------------------------------------------------------------------
// The install note. Written into the package, because the person who unpacks it
// is not the person reading this repository.
// ---------------------------------------------------------------------------

function installNote(archive) {
  return `# 安装 ${pkg.name}

这是一个 DeepSeek Harness 插件包（${archive}，${pkg.name}@${pkg.version}）。

## 一、装到某个 profile 里

DSH 的插件放在 profile 的 \`node_modules\` 下。把包解开，让
\`<profile>/node_modules/${pkg.name}/\` 里直接就是 \`package.json\`：

\`\`\`powershell
# 1) 解开（把 <profile> 换成你的，例如 D:\\dsh-home\\profiles\\desktop）
tar -xzf ${archive} -C <profile>\\node_modules
Rename-Item <profile>\\node_modules\\package <profile>\\node_modules\\${pkg.name}
\`\`\`

包里的路径以 \`package/\` 开头，所以解开后需要改名一次；这是 tar 的常规形状。
**目录名必须是包名 \`${pkg.name}\`**：宿主按包名解析这一行，改成别的名字它就找不到。
（插件 id 仍是 \`dsh-novel\`，路由前缀与写头都用它，与目录名无关。）

## 二、装依赖

宿主半依赖 **js-yaml**（读写章节的 YAML front matter）。profile 里已经有它就不用管；
没有的话在 profile 目录执行：

\`\`\`powershell
pnpm add js-yaml      # 或 npm i js-yaml
\`\`\`

客户端半只依赖 \`react\`，由 DSH 的模块加载器提供，不需要单独安装。

## 三、重启 DSH

插件在启动时注册，重启后 \`/dsh-novel/health\` 应该返回 \`{"ok":true}\`：

\`\`\`powershell
curl http://127.0.0.1:19387/dsh-novel/health
\`\`\`

界面里会出现侧栏入口「小说」。**注意**：写作 / 校验 / 文风三个技能位于**工作区的**
\`.dsh/skills/\` 下，不在这个包里——插件负责界面与数据，技能负责写作，两者要一起才有完整功能。

## 四、插件做了什么

- 三栏界面：项目 → 分支（世界 / 时间轴 / 组织 / 人物 / 物品 / 剧情大纲 / 章节）
- 地图：手绘与导入底图、笔迹 / 河流 / 道路 / 边界 / 山脉、标记点、文字、图章、喷漆
- 时间轴：多条时间线、可编辑起止、事件、剧情大纲
- 导出全书为一份 Markdown（写进 \`novel/export/\`，并给出完整路径）
- 纯文本批量导入人物 / 地点 / 物品，可带基础信息
- 交给 agent 写某一章（需要宿主已打上 \`prompt(request, signal)\` 的可选参数补丁）

细节见包里的 \`README.md\`。
`
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`packaging ${pkg.name}@${pkg.version} from ${ROOT}`)
const files = collect()
const jsCount = auditImports(files)
audit(files)
auditManifest()

if (files.length === 0) bad('nothing to package')
if (failed > 0) {
  console.log(`\nFAIL  ${failed} problem(s); nothing was written. Fix them, or use --force if you know better.`)
  process.exit(1)
}

const prefix = 'package'
const archive = `${pkg.name}-${pkg.version}.tgz`
// The entries carry their CONTENT, so the install note is generated into the package rather than kept as a
// second copy in the repository that would drift from this file.
const entries = files.map((path) => ({ path, content: readFileSync(join(ROOT, path)) }))
entries.push({ path: 'INSTALL.md', content: Buffer.from(installNote(archive), 'utf8') })
const tar = makeTar(entries, prefix)
const gz = gzipSync(tar, { level: 9 })
mkdirSync(OUT_DIR, { recursive: true })
const archivePath = join(OUT_DIR, archive)
writeFileSync(archivePath, gz)
// Also beside the archive, so it can be read without unpacking anything. Same bytes as the one inside.
const notePath = join(OUT_DIR, 'INSTALL.md')
writeFileSync(notePath, entries[entries.length - 1].content)

// --- verification: read back what was just written --------------------------
console.log('\nverifying the archive it just wrote…')
const back = readTar(gunzipSync(readFileSync(archivePath)))
const names = back.map((entry) => entry.name)
if (back.length !== entries.length) bad(`archive holds ${back.length} entries, expected ${entries.length}`)
for (const entry of entries) {
  if (!names.includes(`${prefix}/${entry.path}`)) bad(`${entry.path} is missing from the archive`)
}
if (!back.every((entry) => entry.checksumOk)) bad('an entry has a bad tar checksum')
for (const entry of back) {
  const original = entries.find((candidate) => `${prefix}/${candidate.path}` === entry.name)
  if (original === undefined) bad(`${entry.name} is in the archive but was not meant to be`)
  else if (!original.content.equals(entry.content)) bad(`${entry.name} came back different from what went in`)
}

// The strongest check available: unpack it somewhere else and LOAD the host half.
const scratch = join(OUT_DIR, '.package-verify')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
for (const entry of back) {
  const target = join(scratch, ...entry.name.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, entry.content)
}
const unpackedEntry = join(scratch, prefix, pkg.main)
if (!existsSync(unpackedEntry)) {
  bad(`the unpacked ${pkg.main} is not there`)
} else {
  const loaded = await import(pathToFileURL(unpackedEntry).href)
  if (typeof loaded.apply !== 'function') bad('the unpacked host half exports no apply()')
  else note('the unpacked host half imports and exports apply()')
}
const unpackedClient = join(scratch, prefix, 'client', 'client.js')
if (!existsSync(unpackedClient)) bad('the unpacked client bundle is not there')
else {
  // Parsed, not executed: running it needs the host's module loader, but a syntax error would ship silently.
  try {
    new Function('window', 'react', readFileSync(unpackedClient, 'utf8'))
    note('the unpacked client bundle parses')
  } catch (error) {
    bad(`the unpacked client bundle does not parse: ${error.message}`)
  }
}
rmSync(scratch, { recursive: true, force: true })

const size = (statSync(archivePath).size / 1024).toFixed(1)
if (failed > 0) {
  console.log(`\nFAIL  ${failed} problem(s) in the verification`)
  process.exit(1)
}
console.log(`\nOK  ${archive}  (${files.length} files, ${jsCount} host modules, ${size} KB)`)
console.log(`    ${archivePath}`)
console.log('    INSTALL.md is written beside it')
console.log('\n    Install: unpack into <profile>/node_modules, rename `package` to the plugin name, restart DSH.')
