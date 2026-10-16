/**
 * Wait for DSH to quit, then apply the host patch — in one step.
 *
 * WHY THIS EXISTS. `patch-asar.mjs --apply` is correct and its refusal is clear, but it has to be run at a
 * moment when DSH is not running, and DSH closes to the TRAY: shutting the window leaves the process (and
 * the lock on `app.asar`) alive, so a reasonable attempt ends in `EPERM` and the author has to notice that
 * nothing happened. That is exactly what did happen — the patch was reported as applied and the archive was
 * untouched.
 *
 * So this waits. Run it in a NORMAL console window, not from inside the DSH chat: a command started by DSH
 * is a child of DSH, and it dies when DSH does — which is the one moment it needs to survive.
 *
 *   tools\apply-host-patch.cmd                        # wait, then patch
 *   tools\apply-host-patch.cmd --check                # report the state and exit
 *   tools\apply-host-patch.cmd --timeout 30           # wait up to 30 minutes (default 15)
 *
 * It never kills DSH. Losing an unsaved conversation to save one manual click is not a trade this script
 * gets to make on the author's behalf.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH_TOOL = join(HERE, 'patch-asar.mjs')
const DEFAULT_ASAR = 'D:\\deepseekharness\\resources\\app.asar'

/** The one file the patch touches, and the anchor its rule is written against. */
const TARGET = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js'
const ANCHOR = 'prompt(request, signal) {'

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? null : argv[at + 1]
}
const checkOnly = argv.includes('--check')
const asarPath = argv.find((value) => value.toLowerCase().endsWith('.asar')) ?? DEFAULT_ASAR
const timeoutMinutes = Number(flag('timeout') ?? 15)
const waitMs = (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : 15) * 60_000

/** Is the archive open for writing, i.e. is DSH still holding it? */
const isLocked = () => {
  try {
    closeSync(openSync(asarPath, 'r+'))
    return false
  } catch {
    return true
  }
}

/**
 * The state, read straight out of the archive.
 *
 * NOT by capturing the patch tool's output: this runs under a sandbox that refuses piped stdio, and — more
 * to the point — a check that depends on parsing another program's prose is a check that breaks when the
 * prose is reworded. The rule here is a copy of the tool's own: the FIRST `throwIfAborted` call after the
 * anchor decides it. Two readers, one writer: the WRITE still goes through `patch-asar.mjs`, so a wrong
 * reading here can only misreport, never corrupt.
 */
const readState = () => {
  let bytes
  try {
    bytes = readFileSync(asarPath)
  } catch {
    return 'missing'
  }
  try {
    const headerSize = bytes.readUInt32LE(4)
    const jsonLen = bytes.readUInt32LE(12)
    const header = JSON.parse(bytes.toString('utf8', 16, 16 + jsonLen))
    const dataStart = 8 + headerSize
    let node = header
    for (const segment of TARGET.split('/')) node = node?.files?.[segment]
    if (node === undefined || node.files !== undefined) return 'unknown'
    const text = bytes.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + Number(node.size)).toString('utf8')
    const anchorAt = text.indexOf(ANCHOR)
    if (anchorAt === -1) return 'unknown'
    const required = text.indexOf('signal.throwIfAborted();', anchorAt)
    const optional = text.indexOf('signal?.throwIfAborted()', anchorAt)
    if (optional !== -1 && (required === -1 || optional < required)) return 'patched'
    return 'pending'
  } catch {
    return 'unknown'
  }
}

const backups = () => {
  try {
    return readdirSync(dirname(asarPath)).filter((name) => name.includes('.bak-')).length
  } catch {
    return 0
  }
}

console.log(`archive : ${asarPath}`)
console.log(`backups : ${backups()} next to it\n`)

const state = readState()
if (state === 'patched') {
  console.log('状态：已经打过补丁 ✓  什么也不用做。')
  console.log('  撤销：tools\\run.cmd patch-asar.mjs "<app.asar>" --revert')
  process.exit(0)
}
if (state === 'unknown') {
  console.log('状态：读不懂补丁工具的输出。请先单独跑一次预演：')
  console.log(`  tools\\run.cmd patch-asar.mjs "${asarPath}"`)
  process.exit(2)
}
console.log('状态：补丁还没打。')

if (checkOnly) {
  console.log(isLocked() ? '  DSH 还占着这个档案（补充一句：关窗口不够，要从托盘退出）。' : '  档案没被占用，可以直接打。')
  process.exit(0)
}

// --- wait for the lock to go -------------------------------------------------
if (isLocked()) {
  console.log('\nDSH 现在占着这个档案，补丁打不进去。**请完全退出 DSH**：')
  console.log('  1. 关掉所有窗口；')
  console.log('  2. 在系统托盘里右键 DSH 图标 → 退出（只关窗口它会留在托盘里）。');
  console.log('  3. 确认一下：Get-Process "DeepSeek Harness"   应当没有任何输出。')
  console.log(`\n我会在这里等（最多 ${waitMs < 60_000 ? Math.round(waitMs / 1000) + ' 秒' : Math.round(waitMs / 60_000) + ' 分钟'}），它一退出我就自动打补丁。`)
  console.log('注意：这条命令必须在**普通命令行窗口**里跑——在我的对话里跑，DSH 一退它就一起死了。\n')

  const startedAt = Date.now()
  let waited = 0
  while (isLocked()) {
    if (Date.now() - startedAt > waitMs) {
      console.log(`\n等了 ${waitMs < 60_000 ? Math.round(waitMs / 1000) + ' 秒' : Math.round(waitMs / 60_000) + ' 分钟'}，档案仍然被占用。什么也没写。`)
      console.log('  再试一次，或用 --timeout 放宽等待：tools\\apply-host-patch.cmd --timeout 30')
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
    waited += 2
    if (waited % 10 === 0) process.stdout.write(`  还在等…（已等 ${waited} 秒）\n`)
  }
  console.log('\n档案已释放，开始打补丁。\n')
}

// --- apply -------------------------------------------------------------------
// `stdio: 'inherit'` so the tool's own output reaches the author unfiltered. Capturing it would need a pipe,
// which the sandbox refuses — and there is nothing to gain: this script reports the outcome by re-reading
// the archive, which is stronger than trusting a child's exit line.
const applied = spawnSync(process.execPath, [PATCH_TOOL, asarPath, '--apply'], { stdio: 'inherit' })
if (applied.status !== 0) {
  console.log(`\n打补丁失败（退出码 ${applied.status}）。上面是补丁工具的原话，什么也没写。`)
  process.exit(applied.status ?? 1)
}

const after = readState()
console.log('')
if (after !== 'patched') {
  console.log('打完了，但回读没有确认成功——请把上面的完整输出发给我。')
  process.exit(1)
}

console.log('补丁已确认生效 ✓（回读验证：档案内容现在是打过补丁的版本）')
console.log(`备份数量：${backups()}（打补丁前的原件保留着，--revert 可还原）`)
console.log('\n下一步：')
console.log('  1. 重新启动 DSH；')
console.log('  2. 在普通命令行里跑：tools\\run.cmd agent-smoke.mjs')
console.log('     它应该走完 prompt → status → result 并以 0 退出（之前是 BLOCKED / 501）。')
console.log('  3. 回到小说插件 → 章节 → 选中一章，应能看到「交给 agent 写这一章」并可用。')
