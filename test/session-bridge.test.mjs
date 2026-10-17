/**
 * Unit tests for the DSH-side session bridge.
 *
 * Everything here runs against plain-object fakes that mirror the shapes of the
 * real Host services (`sessionController`, `workspaceRegistry`, `sessions`,
 * `agents`) verified in app.asar 0.2.1-rc.2 — no DSH instance, no network.
 *
 * Run: node --test plugin/dsh-plugin-telegram/test/session-bridge.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionBridge, internals } from '../lib/session-bridge.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Build a ready-made workspace entity.
 * @param {string} id - workspace id.
 * @param {string} path - canonical directory.
 * @param {string} title - display title.
 * @param {string[]} [sessionIds] - accounted sessions.
 * @returns {object} entity shaped like a `WorkspaceEntity`.
 */
function workspace(id, path, title, sessionIds = []) {
  return { id, path, title, sessionIds, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}

/**
 * Build one `sessionController.list()` row.
 * @param {object} fields - row fields.
 * @returns {object} row shaped like `summaryFor()`.
 */
function sessionRow(fields) {
  return {
    running: false,
    agentAvailable: false,
    formatStatus: 'current',
    blank: false,
    ...fields,
  }
}

/**
 * Fake workspace registry.
 * @param {object[]} entities - workspaces to expose.
 * @returns {{ list: () => object[], get: (id: string) => object | undefined }} registry fake.
 */
function fakeRegistry(entities) {
  return {
    list: () => entities.map((entity) => ({ ...entity, sessionIds: [...entity.sessionIds] })),
    get: (id) => entities.find((entity) => entity.id === id),
    archivedSessionIds: [],
  }
}

/**
 * Assemble a fake plugin context.
 * @param {object} [overrides] - service overrides.
 * @returns {object} context fake plus a `emit` helper and call log.
 */
function fakeCtx(overrides = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const calls = { prompt: [], cancel: [], rename: [], create: [], list: 0, createProject: [] }
  const rows = overrides.rows ?? []
  const entities = overrides.workspaces ?? []
  const liveSessions = new Map(overrides.liveSessions ?? [])
  const liveAgents = new Map(overrides.liveAgents ?? [])

  const ctx = {
    workspaceRegistry: fakeRegistry(entities),
    workspaceController: {
      create: async ({ path }) => {
        calls.createProject.push(path)
        if (overrides.createProjectError !== undefined) throw new Error(overrides.createProjectError)
        const entity = workspace(`ws-${entities.length + 1}`, path, path.slice(path.lastIndexOf('/') + 1) || path)
        return { workspace: { workspaceId: entity.id, path: entity.path, title: entity.title, sessionIds: [], createdAt: '', updatedAt: '' }, created: true }
      },
    },
    sessionController: {
      list: async (...args) => {
        calls.list += 1
        if (overrides.listError !== undefined) throw new Error(overrides.listError)
        if (overrides.listReturnsArray === true) return rows.map((row) => ({ ...row }))
        return { items: rows.map((row) => ({ ...row })) }
      },
      create: async (request) => {
        calls.create.push(request)
        if (overrides.createError !== undefined) throw new Error(overrides.createError)
        return { sessionId: overrides.createdSessionId ?? 'session-new-0001' }
      },
      prompt: async (request, signal) => {
        calls.prompt.push({ request, signal })
        if (overrides.promptError !== undefined) throw new Error(overrides.promptError)
        return { accepted: true }
      },
      cancel: async (request) => {
        calls.cancel.push(request)
        if (overrides.cancelError !== undefined) throw new Error(overrides.cancelError)
        return { accepted: true }
      },
      rename: async (request) => {
        calls.rename.push(request)
        if (overrides.renameError !== undefined) throw new Error(overrides.renameError)
        return { title: request.title, seq: 1 }
      },
      resolveAgent: async (sessionId) => {
        if (overrides.resolveAgentError !== undefined) return { error: overrides.resolveAgentError }
        if (overrides.resolveAgentThrows === true) throw new Error('boom')
        return { agent: { id: sessionId } }
      },
    },
    sessions: { get: (id) => liveSessions.get(id), list: () => [...liveSessions.values()] },
    agents: { get: (id) => liveAgents.get(id), roots: () => [...liveAgents.values()] },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    on(name, listener, options) {
      const list = listeners.get(name) ?? []
      list.push({ listener, options })
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.findIndex((entry) => entry.listener === listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    /** Deliver one event to every registered listener, like the Cordis bus. */
    emit(name, ...args) {
      for (const entry of [...(listeners.get(name) ?? [])]) entry.listener(...args)
    },
    listenerCount(name) {
      return (listeners.get(name) ?? []).length
    },
    /** Options the last listener was registered with, for global-check assertions. */
    listenerOptions(name) {
      return (listeners.get(name) ?? []).map((entry) => entry.options)
    },
    calls,
  }
  return ctx
}

/**
 * Build a live session-shaped object.
 * @param {string} id - session id.
 * @param {object} [header] - header overrides.
 * @returns {{ id: string, header: object, snapshotEvents: () => object[] }} session fake.
 */
function liveSession(id, header = {}) {
  return { id, header: { id, createdAt: 1_700_000_000_000, ...header }, snapshotEvents: () => [] }
}

/**
 * Wrap an event in the `(session, event)` shape `session/event` delivers.
 * @param {string} sessionId - emitting session.
 * @param {object} event - event payload.
 * @returns {[object, object]} dispatch arguments.
 */
function eventArgs(sessionId, event) {
  return [{ id: sessionId }, event]
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test('listProjects maps workspace entities with a session count', async () => {
  const ctx = fakeCtx({
    workspaces: [
      workspace('ws-1', 'C:\\repo\\alpha', 'Alpha', ['s1', 's2']),
      workspace('ws-2', 'C:\\repo\\beta', 'Beta'),
    ],
  })
  const bridge = createSessionBridge(ctx)
  assert.deepEqual(await bridge.listProjects(), [
    { id: 'ws-1', title: 'Alpha', path: 'C:\\repo\\alpha', sessionCount: 2 },
    { id: 'ws-2', title: 'Beta', path: 'C:\\repo\\beta', sessionCount: 0 },
  ])
})

test('listProjects degrades to an empty list when the registry is missing or broken', async () => {
  assert.deepEqual(await createSessionBridge({}).listProjects(), [])
  const throwing = { workspaceRegistry: { list() { throw new Error('registry unavailable') } }, logger: { warn() {} } }
  assert.deepEqual(await createSessionBridge(throwing).listProjects(), [])
})

test('resolveProject resolves by id, exact title, case-insensitive title and path', async () => {
  const ctx = fakeCtx({
    workspaces: [
      workspace('ws-1', 'C:\\repo\\alpha', 'Alpha Project', ['s1']),
      workspace('ws-2', 'C:\\repo\\beta', 'beta'),
    ],
  })
  const bridge = createSessionBridge(ctx)
  assert.equal((await bridge.resolveProject('ws-1'))?.title, 'Alpha Project')
  assert.equal((await bridge.resolveProject('Alpha Project'))?.id, 'ws-1')
  assert.equal((await bridge.resolveProject('  alpha project '))?.id, 'ws-1')
  assert.equal((await bridge.resolveProject('beta'))?.id, 'ws-2')
  // Paths compare with either separator and ignore the trailing separator.
  assert.equal((await bridge.resolveProject('C:/repo/alpha/'))?.id, 'ws-1')
  assert.equal((await bridge.resolveProject('C:\\repo\\BETA'))?.id, 'ws-2')
  // A unique title prefix is accepted; an unknown reference is undefined.
  assert.equal((await bridge.resolveProject('Alpha'))?.id, 'ws-1')
  assert.equal(await bridge.resolveProject('gamma'), undefined)
  assert.equal(await bridge.resolveProject(''), undefined)
  assert.equal(await bridge.resolveProject(undefined), undefined)
})

test('resolveProject accepts a 1-based list index', async () => {
  const ctx = fakeCtx({ workspaces: [workspace('ws-1', 'C:\\a', 'A'), workspace('ws-2', 'C:\\b', 'B')] })
  const bridge = createSessionBridge(ctx)
  assert.equal((await bridge.resolveProject(2))?.id, 'ws-2')
  assert.equal(await bridge.resolveProject(3), undefined)
})

test('resolveProject prefers an id over a title collision', async () => {
  // "ws-1" is also a plausible title; a raw id match must win.
  const ctx = fakeCtx({ workspaces: [workspace('ws-9', 'C:\\x', 'ws-1'), workspace('ws-1', 'C:\\y', 'Other')] })
  const bridge = createSessionBridge(ctx)
  assert.equal((await bridge.resolveProject('ws-1'))?.path, 'C:\\y')
})

test('createProject registers a directory through the workspace controller', async () => {
  const ctx = fakeCtx({ workspaces: [] })
  const bridge = createSessionBridge(ctx)
  const project = await bridge.createProject('C:\\repo\\new')
  assert.deepEqual(ctx.calls.createProject, ['C:\\repo\\new'])
  assert.equal(project?.path, 'C:\\repo\\new')
  assert.equal(project?.id, 'ws-1')
})

test('createProject returns undefined instead of throwing on failure', async () => {
  const ctx = fakeCtx({ workspaces: [], createProjectError: 'not a directory' })
  const bridge = createSessionBridge(ctx)
  assert.equal(await bridge.createProject('C:\\nope'), undefined)
  assert.equal(await createSessionBridge({}).createProject('C:\\nope'), undefined)
  assert.equal(await bridge.createProject('  '), undefined)
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('listSessions reads titles from the title projection and keeps newest-first order', async () => {
  const ctx = fakeCtx({
    rows: [
      sessionRow({ sessionId: 's-new', updatedAt: 300, cwd: 'C:\\repo\\alpha', projections: { kind: 'sequenced', asOfSeq: 1, values: { title: 'Newest' } } }),
      sessionRow({ sessionId: 's-mid', updatedAt: 200, cwd: 'C:\\repo\\alpha', projections: { values: { title: 'Middle' } } }),
      sessionRow({ sessionId: 's-old', updatedAt: 100, cwd: 'C:\\repo\\alpha' }),
    ],
  })
  const bridge = createSessionBridge(ctx)
  const sessions = await bridge.listSessions()
  assert.deepEqual(sessions.map((session) => session.sessionId), ['s-new', 's-mid', 's-old'])
  assert.deepEqual(sessions.map((session) => session.title), ['Newest', 'Middle', ''])
  assert.equal(sessions[0].cwd, 'C:\\repo\\alpha')
})

test('listSessions falls back to the live projection and tolerates a throwing projection service', async () => {
  const live = liveSession('s-live')
  const ctx = fakeCtx({
    rows: [sessionRow({ sessionId: 's-live', updatedAt: 10, cwd: 'C:\\repo\\alpha' })],
    liveSessions: [['s-live', live]],
  })
  ctx.sessionProjections = {
    snapshot(session) {
      if (session.id === 's-broken') throw new Error('projection exploded')
      return { asOfSeq: 1, values: { title: 'Live Title' } }
    },
  }
  const bridge = createSessionBridge(ctx)
  const sessions = await bridge.listSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].title, 'Live Title')

  // A second session whose projection throws must not fail the whole list.
  ctx.sessionProjections.snapshot = () => {
    throw new Error('projection exploded')
  }
  const second = await bridge.listSessions()
  assert.equal(second.length, 1)
  assert.equal(second[0].title, '')
})

test('listSessions filters by the project cwd and drops subagent sessions', async () => {
  const ctx = fakeCtx({
    workspaces: [workspace('ws-1', 'C:\\repo\\alpha', 'Alpha'), workspace('ws-2', 'C:\\repo\\beta', 'Beta')],
    rows: [
      sessionRow({ sessionId: 'a-1', updatedAt: 5, cwd: 'C:\\repo\\alpha', projections: { values: { title: 'In alpha' } } }),
      sessionRow({ sessionId: 'a-2', updatedAt: 4, cwd: 'c:/repo/alpha', projections: { values: { title: 'In alpha, other case' } } }),
      sessionRow({ sessionId: 'b-1', updatedAt: 3, cwd: 'C:\\repo\\beta', projections: { values: { title: 'In beta' } } }),
      sessionRow({ sessionId: 'sub-1', updatedAt: 2, cwd: 'C:\\repo\\alpha', origin: 'subagent', projections: { values: { title: 'Subagent' } } }),
      sessionRow({ sessionId: 'child-1', updatedAt: 1, cwd: 'C:\\repo\\alpha', parentSessionId: 'a-1' }),
    ],
  })
  const bridge = createSessionBridge(ctx)
  const alpha = await bridge.listSessions({ projectId: 'ws-1' })
  assert.deepEqual(alpha.map((session) => session.sessionId), ['a-1', 'a-2'])
  const local = await bridge.listSessions({ projectId: 'ws-2' })
  assert.deepEqual(local.map((session) => session.sessionId), ['b-1'])
  // No project: every non-subagent session.
  const all = await bridge.listSessions()
  assert.deepEqual(all.map((session) => session.sessionId), ['a-1', 'a-2', 'b-1'])
})

test('listSessions honours the workspace sessionIds accounting for rows without cwd', async () => {
  const ctx = fakeCtx({
    workspaces: [workspace('ws-1', 'C:\\repo\\alpha', 'Alpha', ['accounted-1'])],
    rows: [
      sessionRow({ sessionId: 'accounted-1', updatedAt: 2 }),
      sessionRow({ sessionId: 'other-1', updatedAt: 1, cwd: 'C:\\elsewhere' }),
    ],
  })
  const bridge = createSessionBridge(ctx)
  const sessions = await bridge.listSessions({ projectId: 'ws-1' })
  assert.deepEqual(sessions.map((session) => session.sessionId), ['accounted-1'])
})

test('listSessions prefers the authoritative running flag and falls back to the agent status', async () => {
  // A simplified/older host may omit `running`; only then is the agent consulted.
  /** @param {object} fields - row fields without `running`. */
  const withoutRunning = (fields) => {
    const row = sessionRow(fields)
    delete row.running
    return row
  }
  const ctx = fakeCtx({
    rows: [
      sessionRow({ sessionId: 'running-row', updatedAt: 3, running: true }),
      sessionRow({ sessionId: 'idle-row', updatedAt: 2, running: false }),
      withoutRunning({ sessionId: 'agent-row', updatedAt: 1 }),
      withoutRunning({ sessionId: 'agent-idle', updatedAt: 0 }),
    ],
    liveAgents: [
      ['agent-row', { id: 'agent-row', status: 'running' }],
      ['agent-idle', { id: 'agent-idle', status: 'idle' }],
    ],
  })
  const bridge = createSessionBridge(ctx)
  const sessions = await bridge.listSessions()
  const running = Object.fromEntries(sessions.map((session) => [session.sessionId, session.running]))
  assert.deepEqual(running, { 'running-row': true, 'idle-row': false, 'agent-row': true, 'agent-idle': false })
})

test('listSessions applies a limit and survives a failing list call', async () => {
  const ctx = fakeCtx({
    rows: Array.from({ length: 10 }, (_, index) => sessionRow({ sessionId: `s-${index}`, updatedAt: index })),
  })
  const bridge = createSessionBridge(ctx)
  assert.equal((await bridge.listSessions({ limit: 3 })).length, 3)
  assert.equal((await bridge.listSessions({ limit: 0 })).length, 10)

  const failing = createSessionBridge(fakeCtx({ listError: 'persistence offline' }))
  assert.deepEqual(await failing.listSessions(), [])
  assert.deepEqual(await createSessionBridge({}).listSessions(), [])
})

test('listSessions accepts an array-returning controller (shape tolerance)', async () => {
  const ctx = fakeCtx({ rows: [sessionRow({ sessionId: 's-1', updatedAt: 1 })], listReturnsArray: true })
  const sessions = await createSessionBridge(ctx).listSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, 's-1')
})

test('resolveSession resolves a full id, a unique prefix, and a 1-based index', async () => {
  const ctx = fakeCtx({
    workspaces: [workspace('ws-1', 'C:\\repo\\alpha', 'Alpha'), workspace('ws-2', 'C:\\repo\\beta', 'Beta')],
    rows: [
      sessionRow({ sessionId: 'session-aaaa-1111', updatedAt: 30, cwd: 'C:\\repo\\alpha' }),
      sessionRow({ sessionId: 'session-bbbb-2222', updatedAt: 20, cwd: 'C:\\repo\\alpha' }),
      sessionRow({ sessionId: 'session-cccc-3333', updatedAt: 10, cwd: 'C:\\repo\\beta' }),
    ],
  })
  const bridge = createSessionBridge(ctx)
  assert.equal((await bridge.resolveSession('session-bbbb-2222'))?.sessionId, 'session-bbbb-2222')
  assert.equal((await bridge.resolveSession('session-cccc'))?.sessionId, 'session-cccc-3333')
  assert.equal((await bridge.resolveSession(2))?.sessionId, 'session-bbbb-2222')
  assert.equal(await bridge.resolveSession(9), undefined)
  assert.equal(await bridge.resolveSession('missing'), undefined)
  assert.equal(await bridge.resolveSession(''), undefined)

  // With a project selected, indexes count the project's sessions only.
  bridge.setCurrentProject('ws-2')
  assert.equal((await bridge.resolveSession(1))?.sessionId, 'session-cccc-3333')
  assert.equal(await bridge.resolveSession(2), undefined)
})

test('resolveSession refuses an ambiguous prefix instead of guessing', async () => {
  const ctx = fakeCtx({
    rows: [
      sessionRow({ sessionId: 'session-aaa-1', updatedAt: 2 }),
      sessionRow({ sessionId: 'session-aaa-2', updatedAt: 1 }),
    ],
  })
  const bridge = createSessionBridge(ctx)
  assert.equal(await bridge.resolveSession('session-aaa'), undefined)
  assert.equal((await bridge.resolveSession('session-aaa-1'))?.sessionId, 'session-aaa-1')
})

test('resolveSession falls back to the live session store', async () => {
  const ctx = fakeCtx({
    rows: [],
    liveSessions: [['live-one', liveSession('live-one', { cwd: 'C:\\repo\\alpha', createdAt: 42 })]],
    liveAgents: [['live-one', { id: 'live-one', status: 'running' }]],
  })
  const bridge = createSessionBridge(ctx)
  const session = await bridge.resolveSession('live-one')
  assert.equal(session?.sessionId, 'live-one')
  assert.equal(session?.cwd, 'C:\\repo\\alpha')
  assert.equal(session?.running, true)
})

test('createSession passes workspaceId (never cwd) when a project is given', async () => {
  const ctx = fakeCtx({ workspaces: [workspace('ws-1', 'C:\\repo\\alpha', 'Alpha')] })
  const bridge = createSessionBridge(ctx)
  const created = await bridge.createSession({ projectId: 'ws-1' })
  assert.deepEqual(ctx.calls.create, [{ workspaceId: 'ws-1' }])
  assert.deepEqual(created, { sessionId: 'session-new-0001', cwd: 'C:\\repo\\alpha' })
  // The new session becomes current so the next plain-text message lands in it.
  assert.equal(bridge.currentSession()?.sessionId, 'session-new-0001')
  assert.equal(bridge.currentSession()?.cwd, 'C:\\repo\\alpha')

  await bridge.createSession()
  assert.deepEqual(ctx.calls.create[1], {})
})

test('createSession rejects with the host message on failure', async () => {
  const ctx = fakeCtx({ createError: 'workspace "ws-x" not found' })
  await assert.rejects(createSessionBridge(ctx).createSession({ projectId: 'ws-x' }), /ws-x/)
  await assert.rejects(createSessionBridge({}).createSession(), /unavailable/)
})

// ---------------------------------------------------------------------------
// sendPrompt
// ---------------------------------------------------------------------------

test('sendPrompt delivers text content with a fresh requestId and followup mode', async () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  assert.deepEqual(await bridge.sendPrompt('session-1', 'hello there'), { ok: true })

  const [call] = ctx.calls.prompt
  assert.equal(call.request.sessionId, 'session-1')
  assert.deepEqual(call.request.content, [{ type: 'text', text: 'hello there' }])
  assert.equal(call.request.mode, 'followup')
  assert.match(call.request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.ok(call.signal instanceof AbortSignal)

  // Two prompts never reuse an idempotency key.
  await bridge.sendPrompt('session-1', 'again')
  assert.notEqual(ctx.calls.prompt[0].request.requestId, ctx.calls.prompt[1].request.requestId)
})

test('sendPrompt returns { ok: false } for an { error } resolveAgent result', async () => {
  const ctx = fakeCtx({ resolveAgentError: 'session "session-1" not found' })
  const bridge = createSessionBridge(ctx)
  const result = await bridge.sendPrompt('session-1', 'hello')
  assert.deepEqual(result, { ok: false, error: 'session "session-1" not found' })
  assert.equal(ctx.calls.prompt.length, 0)
})

test('sendPrompt never throws: controller failure, thrown resolveAgent, bad input', async () => {
  const failing = createSessionBridge(fakeCtx({ promptError: 'session/agent-busy: prompt rejected' }))
  assert.deepEqual(await failing.sendPrompt('session-1', 'hello'), { ok: false, error: 'session/agent-busy: prompt rejected' })

  const thrown = createSessionBridge(fakeCtx({ resolveAgentThrows: true }))
  assert.deepEqual(await thrown.sendPrompt('session-1', 'hello'), { ok: false, error: 'boom' })

  const bridge = createSessionBridge(fakeCtx())
  assert.equal((await bridge.sendPrompt('', 'hello')).ok, false)
  assert.equal((await bridge.sendPrompt('session-1', '   ')).ok, false)
  assert.equal((await createSessionBridge({}).sendPrompt('session-1', 'hello')).ok, false)
})

// ---------------------------------------------------------------------------
// cancel / rename
// ---------------------------------------------------------------------------

test('cancel forwards the session id and tolerates a missing session', async () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  await bridge.cancel('session-1')
  assert.deepEqual(ctx.calls.cancel, [{ sessionId: 'session-1' }])

  const notFound = createSessionBridge(fakeCtx({ cancelError: 'session/not-found: session "x" not found (not attached)' }))
  await assert.doesNotReject(notFound.cancel('x'))

  const broken = createSessionBridge(fakeCtx({ cancelError: 'gateway/internal: boom' }))
  await assert.rejects(broken.cancel('x'), /gateway\/internal/)
  await assert.doesNotReject(createSessionBridge({}).cancel('x'))
  await assert.doesNotReject(bridge.cancel(''))
})

test('renameSession forwards the title and updates the cached selection', async () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  bridge.setCurrentSession('session-1')
  await bridge.renameSession('session-1', '  A  better   title ')
  assert.deepEqual(ctx.calls.rename, [{ sessionId: 'session-1', title: 'A better title' }])
  assert.equal(bridge.currentSession()?.title, 'A better title')

  await assert.rejects(createSessionBridge(fakeCtx({ renameError: 'session/title-invalid: blank' })).renameSession('s', 'x'), /title-invalid/)
  await assert.rejects(bridge.renameSession('session-1', '   '), /title is required/)
  await assert.rejects(createSessionBridge({}).renameSession('s', 't'), /unavailable/)
})

// ---------------------------------------------------------------------------
// watchSession
// ---------------------------------------------------------------------------

test('watchSession reports accumulating assistant text per turn', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const seen = []
  const stop = bridge.watchSession('session-1', { onAssistant: (text) => seen.push(text) })

  ctx.emit('session/event', ...eventArgs('other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ignored' }] } } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'turn/start', data: { turn: 1 } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first step' }] } } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second step' }] } } }))

  assert.deepEqual(seen, ['first step', 'first step\n\nsecond step'])
  stop()
})

test('watchSession extracts text from multi-block assistant messages', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const seen = []
  bridge.watchSession('session-1', { onAssistant: (text) => seen.push(text) })
  ctx.emit('session/event', ...eventArgs('session-1', {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'thinking', thinking: 'weighing options' },
          { type: 'text', text: 'Here is the plan.' },
          { type: 'tool-call', id: 'call-1', name: 'fs_read', arguments: '{}' },
          { type: 'text', text: 'Then we ship.' },
        ],
      },
    },
  }))
  assert.deepEqual(seen, ['Here is the plan.\nThen we ship.'])

  // Thinking text is available only when explicitly requested.
  const withThinking = []
  bridge.watchSession('session-1', { onAssistant: (text) => withThinking.push(text), includeThinking: true })
  ctx.emit('session/event', ...eventArgs('session-1', {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'deep thought' }, { type: 'text', text: 'Answer.' }] } },
  }))
  assert.equal(withThinking[0], '_deep thought_\nAnswer.')
})

test('watchSession ignores content-free assistant messages', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const seen = []
  bridge.watchSession('session-1', { onAssistant: (text) => seen.push(text) })
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [] } } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c', name: 'n', arguments: '{}' }] } } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message' }))
  assert.deepEqual(seen, [])
})

test('watchSession reports tool phases and turn/end reasons', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const tools = []
  const ends = []
  const stop = bridge.watchSession('session-1', {
    onTool: (name, phase) => tools.push([name, phase]),
    onTurnEnd: (reason) => ends.push(reason),
  })
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'tool/call', data: { callId: 'call-1', name: 'pwsh', arguments: '{}' } }))
  ctx.emit('session/event', ...eventArgs('session-1', {
    type: 'tool/result',
    data: { message: { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [] } },
  }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } }))
  // A turn/end without a reason still reports a usable value.
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'turn/end', data: {} }))

  assert.deepEqual(tools, [['pwsh', 'start'], ['pwsh', 'end']])
  assert.deepEqual(ends, ['completed', 'aborted', 'completed'])
  stop()
})

test('watchSession resets accumulation at the next turn', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const seen = []
  bridge.watchSession('session-1', { onAssistant: (text) => seen.push(text) })
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'turn one' }] } } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } }))
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'turn two' }] } } }))
  assert.deepEqual(seen, ['turn one', 'turn two'])
})

test('watchSession registers a global listener and unsubscribe detaches it', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const seen = []
  const stop = bridge.watchSession('session-1', { onAssistant: (text) => seen.push(text) })
  assert.equal(ctx.listenerCount('session/event'), 1)
  assert.deepEqual(ctx.listenerOptions('session/event'), [{ global: true }])

  stop()
  assert.equal(ctx.listenerCount('session/event'), 0)
  ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'late' }] } } }))
  assert.deepEqual(seen, [])
  // Unsubscribing twice is safe.
  assert.doesNotThrow(() => stop())
})

test('watchSession isolates a throwing watcher from the others', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const healthy = []
  bridge.watchSession('session-1', {
    onAssistant() {
      throw new Error('this watcher is broken')
    },
  })
  bridge.watchSession('session-1', { onAssistant: (text) => healthy.push(text) })

  // The Host's append path must survive the throwing listener.
  assert.doesNotThrow(() => {
    ctx.emit('session/event', ...eventArgs('session-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'still delivered' }] } } }))
  })
  assert.deepEqual(healthy, ['still delivered'])
})

test('watchSession handles async onTurnEnd rejections without escaping', async () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const warnings = []
  ctx.logger.warn = (message) => warnings.push(message)
  let settled = false
  bridge.watchSession('session-1', {
    async onTurnEnd() {
      settled = true
      throw new Error('send failed')
    },
  })
  assert.doesNotThrow(() => ctx.emit('session/event', ...eventArgs('session-1', { type: 'turn/end', data: { reason: { kind: 'error' } } })))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /send failed/)
})

test('watchSession is safe for a cold session and for a context without on()', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const cold = bridge.watchSession('never-opened', { onAssistant() {} })
  assert.equal(typeof cold, 'function')
  assert.equal(ctx.listenerCount('session/event'), 1)
  cold()

  const noBus = createSessionBridge({})
  assert.doesNotThrow(() => noBus.watchSession('s', {})())
})

test('watchSession reports agent errors through onError', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  const errors = []
  bridge.watchSession('session-1', { onError: (message) => errors.push(message) })
  ctx.emit('agent/error', { agent: { id: 'other' }, error: new Error('nope') })
  ctx.emit('agent/error', { agent: { id: 'session-1' }, error: new Error('model unavailable') })
  assert.deepEqual(errors, ['model unavailable'])
})

test('bridge.dispose detaches every watcher it created', () => {
  const ctx = fakeCtx()
  const bridge = createSessionBridge(ctx)
  bridge.watchSession('a', {})
  bridge.watchSession('b', {})
  assert.equal(ctx.listenerCount('session/event'), 2)
  bridge.dispose()
  assert.equal(ctx.listenerCount('session/event'), 0)
})

// ---------------------------------------------------------------------------
// Selection state + info
// ---------------------------------------------------------------------------

test('currentProject/setCurrentProject are synchronous and resolve against the registry', () => {
  const ctx = fakeCtx({ workspaces: [workspace('ws-1', 'C:\\repo\\alpha', 'Alpha')] })
  const bridge = createSessionBridge(ctx)
  assert.equal(bridge.currentProject(), null)
  assert.ok(!(bridge.currentProject() instanceof Promise))

  bridge.setCurrentProject('ws-1')
  assert.deepEqual(bridge.currentProject(), { id: 'ws-1', title: 'Alpha', path: 'C:\\repo\\alpha' })

  bridge.setCurrentProject('ws-missing')
  assert.equal(bridge.currentProject(), null)

  bridge.setCurrentProject('ws-1')
  bridge.setCurrentProject(null)
  assert.equal(bridge.currentProject(), null)
  assert.equal(createSessionBridge({}).currentProject(), null)
})

test('currentSession/setCurrentSession accept both a record and a plain id string', () => {
  const bridge = createSessionBridge(fakeCtx())
  assert.equal(bridge.currentSession(), null)

  bridge.setCurrentSession('session-1')
  assert.equal(bridge.currentSession()?.sessionId, 'session-1')
  assert.ok(!(bridge.currentSession() instanceof Promise))

  bridge.setCurrentSession({ sessionId: 'session-2', title: 'Plan', cwd: 'C:\\repo' })
  assert.deepEqual(bridge.currentSession(), { sessionId: 'session-2', title: 'Plan', cwd: 'C:\\repo' })

  // Re-selecting the same id keeps the known title.
  bridge.setCurrentSession('session-2')
  assert.equal(bridge.currentSession()?.title, 'Plan')

  bridge.setCurrentSession(null)
  assert.equal(bridge.currentSession(), null)
})

test('info reports hostname, optional version and cwd', () => {
  const info = createSessionBridge(fakeCtx(), { dshVersion: '0.2.1-rc.2' }).info()
  assert.equal(typeof info.hostname, 'string')
  assert.equal(info.dshVersion, '0.2.1-rc.2')
  assert.equal(info.cwd, process.cwd())

  const bare = createSessionBridge({}).info()
  assert.equal(typeof bare.hostname, 'string')
  assert.equal(bare.cwd, process.cwd())
  assert.equal('dshVersion' in bare, bare.dshVersion !== undefined)
})

test('the bridge exposed on a bare context implements the whole contract', () => {
  const bridge = createSessionBridge({})
  for (const method of [
    'listProjects', 'resolveProject', 'createProject', 'listSessions', 'resolveSession',
    'createSession', 'sendPrompt', 'cancel', 'renameSession', 'watchSession',
    'currentProject', 'setCurrentProject', 'currentSession', 'setCurrentSession', 'info',
  ]) {
    assert.equal(typeof bridge[method], 'function', `${method} must be a function`)
  }
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('internals.normalizePath and samePath compare Windows and POSIX spellings', () => {
  assert.equal(internals.samePath('C:\\repo\\alpha', 'c:/repo/alpha/'), true)
  assert.equal(internals.samePath('C:\\repo\\alpha', 'C:\\repo\\beta'), false)
  assert.equal(internals.samePath(undefined, 'C:\\repo'), false)
  assert.equal(internals.normalizePath(''), '')
  assert.equal(internals.normalizePath(42), '')
})

test('internals.extractAssistantText handles odd payloads', () => {
  assert.equal(internals.extractAssistantText(undefined), '')
  assert.equal(internals.extractAssistantText({ data: {} }), '')
  assert.equal(internals.extractAssistantText({ data: { message: { content: 'nope' } } }), '')
  assert.equal(internals.extractAssistantText({ data: { message: { content: [{ type: 'text', text: '  ' }] } } }), '')
  assert.equal(internals.extractAssistantText({ data: { message: { content: [null, { type: 'text', text: 'ok' }] } } }), 'ok')
})

test('internals.isNotFound recognises Host not-found failures', () => {
  assert.equal(internals.isNotFound(new Error('session/not-found: gone')), true)
  assert.equal(internals.isNotFound({ message: 'workspace "x" was not found' }), true)
  assert.equal(internals.isNotFound('generic failure'), false)
  assert.equal(internals.isNotFound(undefined), false)
})

test('internals.errorMessage never throws', () => {
  assert.equal(internals.errorMessage(new Error('plain')), 'plain')
  assert.equal(internals.errorMessage('text'), 'text')
  assert.equal(internals.errorMessage({ message: 'object message' }), 'object message')
  assert.equal(internals.errorMessage(undefined), 'unknown error')
  const circular = {}
  circular.self = circular
  assert.equal(typeof internals.errorMessage(circular), 'string')
})
