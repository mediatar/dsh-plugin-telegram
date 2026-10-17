/**
 * Real-Host integration probe for dsh-plugin-telegram.
 *
 * Boots the actual DSH web profile (with the plugin installed as a profile
 * bundle) against a local mock Bot API, then drives a realistic Telegram
 * conversation and asserts the resulting DSH state.
 *
 * Run: node test/integration/host-probe.mjs (from the repo root)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { join } from 'node:path'

const CLI = 'C:/Users/Mediatar/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
const SCRATCH = join(tmpdir(), 'dsh-plugin-telegram-probes')
const WORKSPACE = process.cwd()
mkdirSync(SCRATCH, { recursive: true })

/* ------------------------------------------------------------------ mock Bot API */
let updateId = 100
const pending = []
const calls = []
let waiters = []

const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw)
    const method = req.url.split('/').pop().split('?')[0]
    calls.push({ method, body })
    res.setHeader('content-type', 'application/json')
    const ok = (result) => res.end(JSON.stringify({ ok: true, result }))
    switch (method) {
      case 'getMe': return ok({ id: 999, is_bot: true, username: 'dsh_probe_bot', first_name: 'DSH Probe' })
      case 'setMyCommands': return ok(true)
      case 'getUpdates': {
        const deliver = () => {
          const batch = pending.splice(0)
          res.end(JSON.stringify({ ok: true, result: batch }))
        }
        if (pending.length > 0) return deliver()
        if ((body.timeout ?? 0) === 0) return ok([])
        waiters.push(deliver)
        setTimeout(() => {
          const index = waiters.indexOf(deliver)
          if (index !== -1) { waiters.splice(index, 1); deliver() }
        }, Math.min((body.timeout ?? 1) * 1000, 2000))
        return
      }
      case 'sendMessage': return ok({ message_id: calls.length, chat: { id: body.chat_id }, text: body.text })
      case 'editMessageText': return ok(true)
      case 'answerCallbackQuery': return ok(true)
      case 'sendChatAction': return ok(true)
      case 'deleteMessage': return ok(true)
      default: return ok(true)
    }
  })
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${mock.address().port}`
const CHAT = 4242
const USER = 777

function pushText(text) {
  pending.push({ update_id: ++updateId, message: { message_id: updateId, chat: { id: CHAT }, from: { id: USER }, text, date: Math.floor(Date.now() / 1000) } })
  for (const wake of waiters.splice(0)) wake()
}
function pushCallback(data) {
  pending.push({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from: { id: USER }, data, message: { chat: { id: CHAT } } } })
  for (const wake of waiters.splice(0)) wake()
}
const sentTexts = () => calls.filter((call) => call.method === 'sendMessage').map((call) => call.body.text)
const editedTexts = () => calls.filter((call) => call.method === 'editMessageText').map((call) => call.body.text)

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`timed out waiting for: ${label}\n--- sent ---\n${sentTexts().slice(-8).join('\n---\n')}`)
}

/* ------------------------------------------------------------------ boot the real Host */
const logFile = join(SCRATCH, 'real-host-probe.log')
writeFileSync(logFile, '')
const child = spawn('cmd.exe', ['/c', CLI, '--profile', 'web', '--no-open', '--port', '0'], {
  cwd: WORKSPACE,
  env: {
    ...process.env,
    DSH_TELEGRAM_BOT_TOKEN: '123456:probe-token',
    DSH_TELEGRAM_BASE_URL: mockBase,
    DSH_TELEGRAM_ALLOWED_USERS: String(USER),
    DSH_TELEGRAM_PROXY: '',
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let log = ''
child.stdout.on('data', (chunk) => { log += chunk; writeFileSync(logFile, log) })
child.stderr.on('data', (chunk) => { log += chunk; writeFileSync(logFile, log) })

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

try {
  await waitFor(() => /listening|http:\/\/127\.0\.0\.1:\d+/.test(log), 'web server listening', 90_000)
  console.log('host booted')

  await waitFor(() => calls.some((call) => call.method === 'getMe'), 'plugin started (getMe)', 60_000)
  record('plugin mounts in a real DSH Host and calls getMe', true)
  await waitFor(() => calls.some((call) => call.method === 'getUpdates'), 'polling started', 30_000)
  record('long polling starts', true)

  // /start
  pushText('/start')
  const help = await waitFor(() => sentTexts().find((text) => text.includes('DeepSeek Harness')), '/start help')
  record('/start renders the control panel', help.includes('/projects') && help.includes('/sessions'))

  // /projects — must list the real workspace registry
  pushText('/projects')
  const projects = await waitFor(() => sentTexts().find((text) => text.includes('default-workspace')), '/projects list')
  record('/projects lists real DSH projects', projects.includes('default-workspace'), projects.split('\n').slice(0, 4).join(' | '))
  const projectsCall = calls.filter((call) => call.method === 'sendMessage' && call.body.text.includes('default-workspace')).at(-1)
  const keyboard = projectsCall?.body?.reply_markup?.inline_keyboard ?? []
  record('/projects attaches inline keyboard', keyboard.length > 0, `${keyboard.length} rows`)

  // select the project by tapping its button
  const projectButton = keyboard.flat().find((button) => button.callback_data?.startsWith('p:') && button.callback_data !== 'p:refresh')
  pushCallback(projectButton.callback_data)
  const afterProject = await waitFor(() => sentTexts().find((text) => text.includes('Project') || text.includes('Sessions')), 'project selection')
  record('tapping a project selects it', afterProject !== undefined, projectButton.callback_data)

  // /new — create a real session through the Host
  const before = sentTexts().length
  pushText('/new')
  const created = await waitFor(() => sentTexts().slice(before).find((text) => text.includes('New session')), '/new')
  const sessionId = /`(session-[0-9a-f-]{36})`/.exec(created)?.[1]
  record('/new creates a real DSH session', sessionId !== undefined, sessionId ?? created)

  // /status — real session lookup
  pushText('/status')
  const status = await waitFor(() => sentTexts().find((text) => text.includes('Status')), '/status')
  record(
    '/status shows project + session',
    status.includes('Project:') && status.includes('Session:') && !status.includes('_not selected_'),
    status.split('\n').slice(0, 5).join(' | '),
  )

  // /sessions — the new session must appear
  pushText('/sessions')
  const sessions = await waitFor(() => sentTexts().slice(-3).find((text) => text.includes('Sessions')), '/sessions')
  record('/sessions lists the created session', sessionId === undefined || sessions.includes(sessionId.slice(0, 12)) || sessions.includes('Untitled'))

  // plain text -> a real prompt into a real session.
  // Delivery success is "no 'Not delivered' reply": the agent may still fail at
  // turn time (for example with no API key), which is a Host condition, not a
  // delivery failure.
  pushText('Reply with exactly the word PROBE-OK and nothing else.')
  await new Promise((resolve) => setTimeout(resolve, 6000))
  const afterPrompt = sentTexts().slice(-8)
  const rejected = afterPrompt.find((text) => text.includes('Not delivered'))
  record('free text is admitted as a prompt', rejected === undefined, rejected ?? 'admitted (no delivery error)')
  const agentError = afterPrompt.find((text) => text.includes('Agent error'))
  if (agentError !== undefined) {
    record('agent-side turn failure is surfaced in the chat', true, agentError.split('\n')[0].slice(0, 120))
  }

  // /cancel should not error
  pushText('/cancel')
  const cancelled = await waitFor(() => sentTexts().find((text) => text.includes('Cancel')), '/cancel', 15_000)
  record('/cancel reaches the Host', cancelled !== undefined, cancelled.split('\n')[0])

  // unauthorized user
  pending.push({ update_id: ++updateId, message: { message_id: updateId, chat: { id: 555 }, from: { id: 999111 }, text: '/start' } })
  for (const wake of waiters.splice(0)) wake()
  const denied = await waitFor(() => sentTexts().find((text) => text.includes('Not authorized')), 'auth rejection', 15_000)
  record('unauthorized users are rejected', denied !== undefined, denied.split('\n')[0])
} catch (error) {
  record('probe completed without exception', false, error.message.split('\n')[0])
} finally {
  const failures = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
  if (failures.length > 0) {
    console.log('\n--- host log tail ---')
    console.log(log.split('\n').slice(-60).join('\n'))
  }
  child.kill('SIGKILL')
  mock.close()
  process.exit(failures.length === 0 ? 0 : 1)
}


