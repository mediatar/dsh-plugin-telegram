/**
 * Verifies the documented *profile-patch* configuration path (no env vars):
 * the token, allow-list and poll timeout come from cordis.patch.yml, exactly as
 * the README tells users to configure the plugin.
 *
 * Run: node test/integration/config-probe.mjs (from the repo root)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const CLI = 'C:/Users/Mediatar/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
const SCRATCH = join(tmpdir(), 'dsh-plugin-telegram-probes')
const WORKSPACE = process.cwd()
mkdirSync(SCRATCH, { recursive: true })

const calls = []
let updateId = 900
const pending = []
let waiters = []
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw)
    const method = req.url.split('/').pop().split('?')[0]
    calls.push({ method, body })
    res.setHeader('content-type', 'application/json')
    const ok = (r) => res.end(JSON.stringify({ ok: true, result: r }))
    if (method === 'getMe') return ok({ id: 42, is_bot: true, username: 'patch_config_bot' })
    if (method === 'getUpdates') {
      const deliver = () => { const batch = pending.splice(0); res.end(JSON.stringify({ ok: true, result: batch })) }
      if (pending.length) return deliver()
      if ((body.timeout ?? 0) === 0) return ok([])
      waiters.push(deliver)
      setTimeout(() => { const i = waiters.indexOf(deliver); if (i !== -1) { waiters.splice(i, 1); deliver() } }, 1200)
      return
    }
    return ok({ message_id: calls.length })
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockBase = `http://127.0.0.1:${mock.address().port}`

const logFile = `${SCRATCH}/patch-config-probe.log`
writeFileSync(logFile, '')
const child = spawn('cmd.exe', ['/c', CLI, '--profile', 'web', '--no-open', '--port', '0'], {
  cwd: WORKSPACE,
  env: {
    ...process.env,
    // Deliberately NOT set: DSH_TELEGRAM_BOT_TOKEN, DSH_TELEGRAM_ALLOWED_USERS.
    // The base URL is the only env override, because the mock is local.
    DSH_TELEGRAM_BASE_URL: mockBase,
    DSH_TELEGRAM_BOT_TOKEN: '',
    DSH_TELEGRAM_ALLOWED_USERS: '',
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (c) => { log += c; writeFileSync(logFile, log) })
child.stderr.on('data', (c) => { log += c; writeFileSync(logFile, log) })

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
async function waitFor(fn, label, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timed out: ${label}\n${log.split('\n').slice(-25).join('\n')}`)
}
const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text)

try {
  await waitFor(() => calls.some((c) => c.method === 'getMe'), 'getMe from profile-patch token')
  record('token from cordis.patch.yml config starts the bot', true)

  const started = await waitFor(() => /polling as @patch_config_bot/.exec(log)?.[0], 'startup log line', 30_000)
  record('startup log reports the configured identity', true, started)
  const allowLine = /1 allowed user\(s\)/.exec(log)?.[0]
  record('allowedUsers from the profile patch is honoured', allowLine !== undefined, allowLine ?? log.split('\n').find((l) => l.includes('allowed')))

  // allowed user 777 may drive the bot; 888 may not.
  pending.push({ update_id: ++updateId, message: { message_id: 1, chat: { id: 1 }, from: { id: 888 }, text: '/start' } })
  for (const w of waiters.splice(0)) w()
  await waitFor(() => sent().find((t) => t.includes('Not authorized')), 'unauthorized rejection', 20_000)
  record('a user outside the configured allow-list is rejected', true)

  pending.push({ update_id: ++updateId, message: { message_id: 2, chat: { id: 2 }, from: { id: 777 }, text: '/start' } })
  for (const w of waiters.splice(0)) w()
  const help = await waitFor(() => sent().find((t) => t.includes('DeepSeek Harness')), 'authorized /start', 20_000)
  record('an allowed user gets the control panel', true, help.split('\n')[0])
} catch (error) {
  record('patch-config probe completed without exception', false, error.message.split('\n')[0])
} finally {
  const failures = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
  if (failures.length) console.log(log.split('\n').slice(-40).join('\n'))
  child.kill('SIGKILL')
  mock.close()
  process.exit(failures.length === 0 ? 0 : 1)
}


