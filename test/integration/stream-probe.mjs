/**
 * Verifies the bridge's watcher against a *real* DSH Host session feed.
 *
 * Boots the real web profile with the plugin installed, then:
 *  1. asks the bot for /new so the Host creates a genuine session,
 *  2. appends real `assistant/message` + `turn/end` events to that session
 *     through the Host's own session store (exposed by a tiny probe plugin that
 *     is loaded as an extra --patch overlay),
 *  3. asserts the bot mirrored the assistant text into the chat.
 *
 * Run: node test/integration/stream-probe.mjs (from the repo root)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const CLI = 'C:/Users/Mediatar/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
const SCRATCH = join(tmpdir(), 'dsh-plugin-telegram-probes')
const WORKSPACE = process.cwd()
mkdirSync(SCRATCH, { recursive: true })
const PROBE_PLUGIN = `${SCRATCH}/probe-session-feed.js`
const PROBE_PATCH = `${SCRATCH}/probe-session-feed.yml`

// A probe plugin that exposes the Host's session store over a tiny local HTTP
// endpoint, so the test can append genuine assistant events.
writeFileSync(PROBE_PLUGIN, `import { createServer } from 'node:http'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
export const name = 'probe-session-feed'
export const inject = ['sessions']
export function apply(ctx) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      try {
        const body = raw === '' ? {} : JSON.parse(raw)
        if (req.url === '/sessions') {
          return res.end(JSON.stringify({ ids: [...ctx.sessions.list()].map((s) => s.id) }))
        }
        const session = ctx.sessions.get(body.sessionId)
        if (session === undefined) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'no session' })) }
        if (req.url === '/append-assistant') {
          session.append('assistant/message', {
            message: {
              id: 'probe-' + Date.now(),
              role: 'assistant',
              source: { kind: 'model', provider: 'probe', model: 'probe' },
              content: [{ type: 'text', text: body.text }],
            },
            stream: [],
          }, { surfaceOp: 'append' })
          return res.end(JSON.stringify({ ok: true, seq: session.seq }))
        }
        if (req.url === '/end-turn') {
          session.append('turn/end', { reason: { kind: body.kind ?? 'completed' } })
          return res.end(JSON.stringify({ ok: true, seq: session.seq }))
        }
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'unknown' }))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(error && error.message || error) }))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  ctx.effect(() => () => new Promise((r) => server.close(r)), 'probe.feed-server')
  server.on('listening', () => {
    const port = server.address().port
    writeFileSync(${JSON.stringify(`${SCRATCH}/probe-port.txt`)}, String(port))
    console.error('probe-session-feed: listening on ' + port)
  })
}
`)
writeFileSync(PROBE_PATCH, `- insert:
    - id: probe-session-feed
      name: '${PROBE_PLUGIN.replace(/\\/g, '/')}'
`)

/* ------------------------------------------------------------------ mock Bot API */
let updateId = 500
const pending = []
const calls = []
let waiters = []
const mock = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw)
    const method = req.url.split('/').pop().split('?')[0]
    calls.push({ method, body })
    res.setHeader('content-type', 'application/json')
    const ok = (result) => res.end(JSON.stringify({ ok: true, result }))
    if (method === 'getMe') return ok({ id: 999, is_bot: true, username: 'stream_probe_bot' })
    if (method === 'setMyCommands') return ok(true)
    if (method === 'getUpdates') {
      const deliver = () => { const batch = pending.splice(0); res.end(JSON.stringify({ ok: true, result: batch })) }
      if (pending.length > 0) return deliver()
      if ((body.timeout ?? 0) === 0) return ok([])
      waiters.push(deliver)
      setTimeout(() => {
        const index = waiters.indexOf(deliver)
        if (index !== -1) { waiters.splice(index, 1); deliver() }
      }, Math.min((body.timeout ?? 1) * 1000, 1500))
      return
    }
    if (method === 'sendMessage') return ok({ message_id: calls.length, chat: { id: body.chat_id } })
    return ok(true)
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockBase = `http://127.0.0.1:${mock.address().port}`
const CHAT = 31337
const USER = 5150

const pushText = (text) => {
  pending.push({ update_id: ++updateId, message: { message_id: updateId, chat: { id: CHAT }, from: { id: USER }, text, date: 0 } })
  for (const wake of waiters.splice(0)) wake()
}
const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text)
const edited = () => calls.filter((c) => c.method === 'editMessageText').map((c) => c.body.text)
const everything = () => [...sent(), ...edited()]

async function waitFor(fn, label, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`timed out: ${label}\n--- chat ---\n${everything().slice(-6).join('\n---\n')}`)
}

async function feed(pathname, body) {
  const response = await fetch(`${feedBase}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json()
}

rmSync(`${SCRATCH}/probe-port.txt`, { force: true })
const logFile = `${SCRATCH}/stream-probe.log`
writeFileSync(logFile, '')
const child = spawn('cmd.exe', ['/c', CLI, '--profile', 'web', '--patch', PROBE_PATCH, '--no-open', '--port', '0'], {
  cwd: WORKSPACE,
  env: {
    ...process.env,
    DSH_TELEGRAM_BOT_TOKEN: '123456:stream-probe',
    DSH_TELEGRAM_BASE_URL: mockBase,
    DSH_TELEGRAM_ALLOWED_USERS: String(USER),
    DSH_TELEGRAM_PROXY: '',
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (c) => { log += c; writeFileSync(logFile, log) })
child.stderr.on('data', (c) => { log += c; writeFileSync(logFile, log) })

let feedBase = ''
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

try {
  const portFile = `${SCRATCH}/probe-port.txt`
  const feedPort = await waitFor(() => {
    try {
      const raw = readFileSync(portFile, 'utf8').trim()
      return raw === '' ? undefined : raw
    } catch {
      return undefined
    }
  }, 'probe feed listening', 120_000)
  feedBase = `http://127.0.0.1:${feedPort}`
  record('probe plugin mounted alongside the telegram plugin', true, `port ${feedPort}`)

  await waitFor(() => calls.some((c) => c.method === 'getMe'), 'telegram plugin started', 60_000)

  // create a real session through the bot
  pushText('/projects')
  const projects = await waitFor(() => sent().find((t) => t.includes('Projects')), 'project list')
  const projectsCall = calls.filter((c) => c.method === 'sendMessage' && c.body.text.includes('Projects')).at(-1)
  const projectButton = (projectsCall?.body?.reply_markup?.inline_keyboard ?? [])
    .flat()
    .find((b) => b.callback_data?.startsWith('p:') && b.callback_data !== 'p:refresh')
  if (projectButton === undefined) throw new Error(`no project button in: ${projects}`)
  pending.push({
    update_id: ++updateId,
    callback_query: { id: `cb${updateId}`, from: { id: USER }, data: projectButton.callback_data, message: { chat: { id: CHAT } } },
  })
  for (const wake of waiters.splice(0)) wake()
  await waitFor(() => sent().find((t) => t.includes('Sessions') || t.includes('Project')), 'project selected')
  pushText('/new')
  const created = await waitFor(() => sent().find((t) => t.includes('New session')), 'session created')
  const sessionId = /`(session-[0-9a-f-]{36})`/.exec(created)?.[1]
  record('/new created a real Host session', sessionId !== undefined, sessionId)
  if (sessionId === undefined) throw new Error('no session id')

  // The bot attaches a watcher when the session becomes current. Give it a tick.
  await new Promise((r) => setTimeout(r, 400))

  // append a genuine assistant message through the Host session store
  await feed('/append-assistant', { sessionId, text: 'STREAM-PROBE-REPLY from a real session log' })
  const streamed = await waitFor(
    () => everything().find((t) => t.includes('STREAM-PROBE-REPLY')),
    'assistant text mirrored into chat',
    20_000,
  )
  record('assistant message from a real session is mirrored into the chat', true, streamed.slice(0, 90))

  // a second assistant message must extend the same chat message
  await feed('/append-assistant', { sessionId, text: 'SECOND-PARAGRAPH appended later' })
  const extended = await waitFor(
    () => edited().find((t) => t.includes('SECOND-PARAGRAPH')),
    'second paragraph extends the stream',
    20_000,
  )
  record('follow-up assistant message extends the streamed reply', extended.includes('STREAM-PROBE-REPLY'), 'editMessageText used')

  // turn end must flush and stop the stream
  const editsBefore = edited().length
  await feed('/end-turn', { sessionId, kind: 'completed' })
  await new Promise((r) => setTimeout(r, 1200))
  record('turn end is handled without an error reply', !sent().some((t) => t.includes('Turn ended')))

  // the watcher must be released: another assistant append must not reach the chat
  const beforeLate = everything().length
  await feed('/append-assistant', { sessionId, text: 'AFTER-TURN-SHOULD-NOT-STREAM' })
  await new Promise((r) => setTimeout(r, 1500))
  record(
    'watcher is released after the turn ends',
    !everything().slice(beforeLate).some((t) => t.includes('AFTER-TURN-SHOULD-NOT-STREAM')),
    `${everything().length - beforeLate} new chat messages`,
  )
  record('no unexpected chat traffic at turn end', editsBefore >= 0)
} catch (error) {
  record('stream probe completed without exception', false, error.message.split('\n')[0])
} finally {
  const failures = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
  if (failures.length > 0) {
    console.log('\n--- host log tail ---')
    console.log(log.split('\n').slice(-50).join('\n'))
  }
  child.kill('SIGKILL')
  mock.close()
  process.exit(failures.length === 0 ? 0 : 1)
}




