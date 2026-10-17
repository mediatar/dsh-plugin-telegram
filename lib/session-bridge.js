/**
 * DSH-side facade used by the Telegram bot: projects (workspaces), sessions,
 * prompts, cancellation, renaming, and live assistant output.
 *
 * This module knows nothing about Telegram. It speaks only the Host service
 * surface that a Cordis plugin context exposes:
 *
 *   - `ctx.sessionController` — `create`, `list`, `prompt`, `cancel`, `rename`,
 *     `resolveAgent` (`@deepseek-ai/dsh-api-session-controller`)
 *   - `ctx.workspaceController` — `create` (`@deepseek-ai/dsh-api-workspace-controller`)
 *   - `ctx.workspaceRegistry` — `list`, `get`, `archivedSessionIds` (`@deepseek-ai/dsh-workspace`)
 *   - `ctx.sessions` — `get`, `list` (`@deepseek-ai/dsh-session`)
 *   - `ctx.agents` — `get`, `roots`
 *   - `ctx.on('session/event', (session, event), { global: true })`
 *
 * Two rules shape every method:
 *
 * 1. **Never throw for "not found".** Lookups return `undefined`, prompt
 *    delivery returns `{ ok: false, error }`. Only mutations that the operator
 *    explicitly asked for (`createSession`, `renameSession`) reject, because the
 *    caller shows the failure text to the chat.
 * 2. **Degrade, do not crash.** Every optional service is probed before use, so
 *    the same module runs against a full Desktop Host, a minimal profile, and a
 *    plain object fake in `node --test`.
 *
 * Everything here is a thin adapter; when a Host shape is overloaded (for
 * example `sessionController.list()` returning `{ items }`) the tolerant form
 * is accepted so a version skew degrades instead of exploding.
 *
 * @module dsh-plugin-telegram/session-bridge
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

/** Prompt-admission timeout. Only admission is awaited; the turn itself streams. */
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000
/** Read timeout for session-list persistence. */
const DEFAULT_LIST_TIMEOUT_MS = 30_000
/** Upper bound used when a caller does not constrain the session list. */
const DEFAULT_LIST_LIMIT = 200
/** Block types that carry visible assistant text. */
const TEXT_BLOCK_TYPES = new Set(['text'])
/** Block types that carry model reasoning (never sent to the chat by default). */
const THINKING_BLOCK_TYPES = new Set(['thinking', 'reasoning'])
/** Subagent lineage markers, excluded from the operator-facing session list. */
const SUBAGENT_ORIGIN = 'subagent'

/**
 * Read the single-line error text from any thrown value.
 * @param {unknown} error - thrown value from a Host service.
 * @returns {string} a displayable message.
 */
function errorMessage(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || String(error)
  const candidate = /** @type {{ message?: unknown, error?: unknown }} */ (error)
  if (typeof candidate.message === 'string') return candidate.message
  if (typeof candidate.error === 'string') return candidate.error
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * Recognise a "not found" style failure regardless of how it was wrapped.
 * @param {unknown} error - thrown value from a Host service.
 * @returns {boolean} whether the failure means "this object does not exist".
 */
function isNotFound(error) {
  const text = errorMessage(error).toLowerCase()
  return text.includes('not-found') || text.includes('not found') || text.includes('was not found')
}

/**
 * Normalise one filesystem path for comparison.
 * Windows paths compare case-insensitively and accept either separator; the
 * trailing separator is ignored so `/repo` and `C:\repo\` compare equal.
 * @param {unknown} value - raw path.
 * @returns {string} comparison form, or an empty string for a non-path.
 */
function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let text = value.trim().replace(/\\/g, '/')
  text = text.replace(/\/+$/, '')
  if (process.platform === 'win32') {
    text = text.toLowerCase()
    // `C:/repo` and `C:\repo` are the same directory; drive letters are case-insensitive.
    text = text.replace(/^([a-z]):/, '$1:')
  }
  return text
}

/**
 * Test whether two paths name the same directory.
 * @param {unknown} left - first path.
 * @param {unknown} right - second path.
 * @returns {boolean} whether the paths match.
 */
function samePath(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return a !== '' && a === b
}

/**
 * Compare two names the way an operator types them: trimmed, case-insensitive.
 * @param {unknown} left - first name.
 * @param {unknown} right - second name.
 * @returns {boolean} whether the names match.
 */
function sameName(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return left.trim().toLowerCase() === right.trim().toLowerCase() && left.trim() !== ''
}

/**
 * Project one workspace entity into the bridge's project shape.
 * @param {object} entity - `WorkspaceEntity` from `workspaceRegistry`.
 * @returns {{ id: string, title: string, path: string, sessionCount: number }} project row.
 */
function projectOf(entity) {
  const sessionIds = Array.isArray(entity?.sessionIds) ? entity.sessionIds : []
  const title = typeof entity?.title === 'string' && entity.title !== '' ? entity.title : String(entity?.path ?? '')
  return {
    id: String(entity?.id ?? ''),
    title,
    path: typeof entity?.path === 'string' ? entity.path : '',
    sessionCount: sessionIds.length,
  }
}

/**
 * Reduce a project row to the public project shape.
 * @param {{ id: string, title: string, path: string }} project - project with or without a count.
 * @returns {{ id: string, title: string, path: string }} project without extra fields.
 */
function publicProject(project) {
  return { id: project.id, title: project.title, path: project.path }
}

/**
 * Render one assistant content block as text, when it carries any.
 * @param {object} block - content block from `assistant/message`.
 * @param {boolean} includeThinking - whether reasoning blocks are rendered.
 * @returns {string} block text, or an empty string.
 */
function blockText(block, includeThinking) {
  if (block === null || typeof block !== 'object') return ''
  const type = typeof block.type === 'string' ? block.type : ''
  if (TEXT_BLOCK_TYPES.has(type)) return typeof block.text === 'string' ? block.text : ''
  if (!includeThinking || !THINKING_BLOCK_TYPES.has(type)) return ''
  const text = typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : ''
  // Reasoning is rendered as a distinguishable paragraph so the chat never
  // confuses it with the final answer.
  return text.trim() === '' ? '' : `_${text}_`
}

/**
 * Extract the assistant text of one `assistant/message` event.
 * @param {object} event - session event (`type: 'assistant/message'`).
 * @param {boolean} includeThinking - whether reasoning blocks are rendered.
 * @returns {string} visible text for that message, empty when it has none.
 */
function extractAssistantText(event, includeThinking = false) {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    const text = blockText(block, includeThinking)
    if (text.trim() !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Read the `title` projection from a session-list row, then from the live
 * session's projection snapshot, then give up.
 *
 * `sessionController.list()` rows carry the title only as a projection hint
 * (`row.projections.values.title`); the value is a folded `session/title`
 * event. A cold session whose projection cache missed simply has no title,
 * which is why this never throws and never rejects the whole list.
 *
 * @param {object} row - one `list()` row.
 * @param {object} ctx - plugin context.
 * @returns {string} title text, or an empty string when unknown.
 */
function titleOf(row, ctx) {
  const projected = row?.projections?.values?.title
  if (typeof projected === 'string' && projected !== '') return projected
  if (typeof row?.title === 'string' && row.title !== '') return row.title
  const sessionId = String(row?.sessionId ?? row?.id ?? '')
  if (sessionId === '') return ''
  try {
    const projections = ctx?.sessionProjections
    const session = ctx?.sessions?.get?.(sessionId)
    if (session !== undefined && typeof projections?.snapshot === 'function') {
      const snapshot = projections.snapshot(session)
      const live = snapshot?.values?.title
      if (typeof live === 'string' && live !== '') return live
    }
  } catch {
    // A projection read is a hint: never let it fail a listing.
  }
  try {
    const title = ctx?.sessionTitle?.get?.(ctx?.sessions?.get?.(sessionId))
    if (typeof title?.title === 'string' && title.title !== '') return title.title
  } catch {
    // Optional service; absent or throwing is fine.
  }
  return ''
}

/**
 * Test whether one list row belongs to a subagent session.
 * Subagent sessions are runtime children of an operator turn; surfacing them
 * in the Telegram list would let the operator "talk" to a tool call.
 * @param {object} row - one `list()` row.
 * @returns {boolean} whether the row is a subagent session.
 */
function isSubagentRow(row) {
  if (row?.origin === SUBAGENT_ORIGIN) return true
  return row?.parentSessionId !== undefined && row?.parentSessionId !== null
}

/**
 * Resolve the DSH application version when the host exposes it cheaply.
 * @param {object} ctx - plugin context.
 * @param {object} options - bridge options.
 * @returns {string | undefined} version text, when known.
 */
function resolveVersion(ctx, options) {
  const explicit = options?.dshVersion ?? process.env.DSH_VERSION
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  for (const candidate of [ctx?.hostInfo?.version, ctx?.version, ctx?.dshVersion, ctx?.brand?.version]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * Create the session bridge over one plugin context.
 *
 * @param {{
 *   sessionController?: object,
 *   workspaceController?: object,
 *   workspaceRegistry?: object,
 *   sessions?: object,
 *   agents?: object,
 *   sessionProjections?: object,
 *   logger?: { debug?: Function, warn?: Function, info?: Function, error?: Function },
 *   on?: Function,
 * }} ctx - Cordis plugin context (or a test double).
 * @param {{ promptTimeoutMs?: number, listTimeoutMs?: number, dshVersion?: string }} [options] - tuning knobs.
 * @returns {object} the bridge described in `plugin/SPEC.md`.
 */
export function createSessionBridge(ctx, options = {}) {
  const promptTimeoutMs = Number.isFinite(options.promptTimeoutMs) ? Number(options.promptTimeoutMs) : DEFAULT_PROMPT_TIMEOUT_MS
  const listTimeoutMs = Number.isFinite(options.listTimeoutMs) ? Number(options.listTimeoutMs) : DEFAULT_LIST_TIMEOUT_MS
  /** Currently selected project id (per process; persistence is not required). */
  let currentProjectId = null
  /** Currently selected session record `{ sessionId, title?, cwd? }`. */
  let currentSessionRecord = null
  /** Live watcher disposers, so a plugin teardown can detach them all. */
  const watchers = new Set()

  /**
   * Log at debug level when the context exposes a logger.
   * @param {string} message - text to log.
   * @returns {void}
   */
  function debug(message) {
    try {
      ctx?.logger?.debug?.(message)
    } catch {
      // Logging must never break a Host call.
    }
  }

  /**
   * Log at warn level when the context exposes a logger.
   * @param {string} message - text to log.
   * @returns {void}
   */
  function warn(message) {
    try {
      ctx?.logger?.warn?.(message)
    } catch {
      // Logging must never break a Host call.
    }
  }

  /**
   * Read the workspace entities, tolerating an absent registry.
   * @returns {object[]} ordered workspace entities.
   */
  function workspaceEntities() {
    try {
      const listed = ctx?.workspaceRegistry?.list?.()
      if (!Array.isArray(listed)) return []
      return listed.filter((entity) => entity !== null && typeof entity === 'object')
    } catch (error) {
      warn(`telegram-bridge: workspace list failed: ${errorMessage(error)}`)
      return []
    }
  }

  /**
   * Look one workspace entity up by id without creating it.
   * @param {string} id - workspace id.
   * @returns {object | undefined} the entity, when known.
   */
  function workspaceEntity(id) {
    if (typeof id !== 'string' || id === '') return undefined
    try {
      const direct = ctx?.workspaceRegistry?.get?.(id)
      if (direct !== undefined && direct !== null) return direct
    } catch {
      // Fall through to the linear scan below.
    }
    return workspaceEntities().find((entity) => String(entity.id) === id)
  }

  /**
   * List every project (workspace) the Host knows about.
   * @returns {Promise<Array<{ id: string, title: string, path: string, sessionCount: number }>>} projects.
   */
  async function listProjects() {
    return workspaceEntities().map(projectOf)
  }

  /**
   * Resolve a project reference by id, exact title, or path.
   *
   * The bot resolves bare numbers itself against the message it rendered, but a
   * numbered reference is accepted here too as a last resort so a stale
   * callback payload still lands somewhere sensible.
   *
   * @param {string | number} ref - id, title, path, or 1-based list index.
   * @returns {Promise<{ id: string, title: string, path: string } | undefined>} project or undefined.
   */
  async function resolveProject(ref) {
    const text = String(ref ?? '').trim()
    if (text === '') return undefined
    const projects = workspaceEntities().map(projectOf)
    if (projects.length === 0) return undefined
    const byId = projects.find((project) => project.id === text)
    if (byId !== undefined) return publicProject(byId)
    const byTitle = projects.find((project) => project.title === text) ?? projects.find((project) => sameName(project.title, text))
    if (byTitle !== undefined) return publicProject(byTitle)
    const byPath = projects.find((project) => samePath(project.path, text))
    if (byPath !== undefined) return publicProject(byPath)
    if (/^\d+$/.test(text)) {
      const index = Number(text)
      if (Number.isInteger(index) && index >= 1 && index <= projects.length) return publicProject(projects[index - 1])
    }
    // Unique case-insensitive title prefix, so `/p dsh` picks "dsh-plugin-telegram".
    const lower = text.toLowerCase()
    const prefixed = projects.filter((project) => project.title.toLowerCase().startsWith(lower))
    if (prefixed.length === 1) return publicProject(prefixed[0])
    return undefined
  }

  /**
   * Register (or reuse) a project for an existing directory.
   *
   * A failed registration logs and returns undefined rather than throwing: the
   * bridge's contract is "lookups and registrations never throw". The error
   * text is logged so it reaches the Host log.
   *
   * @param {string} path - fully qualified directory path.
   * @returns {Promise<{ id: string, title: string, path: string } | undefined>} project or undefined.
   */
  async function createProject(path) {
    const directory = String(path ?? '').trim()
    if (directory === '') return undefined
    try {
      const controller = ctx?.workspaceController
      let entity
      if (typeof controller?.create === 'function') {
        const result = await controller.create({ path: directory })
        entity = result?.workspace ?? result
      } else if (typeof ctx?.workspaceRegistry?.create === 'function') {
        entity = await ctx.workspaceRegistry.create(directory)
      } else {
        warn('telegram-bridge: createProject is unavailable: this Host mounts no workspace service')
        return undefined
      }
      if (entity === undefined || entity === null) return undefined
      // The controller projects `workspaceId`; the registry entity exposes `id`.
      const normalized = projectOf({ ...entity, id: entity.id ?? entity.workspaceId })
      return publicProject(normalized)
    } catch (error) {
      warn(`telegram-bridge: cannot register project "${directory}": ${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * Read the raw session-list rows without any filtering or shaping.
   * @returns {Promise<object[]>} rows from `sessionController.list`.
   */
  async function rawSessionRows() {
    const controller = ctx?.sessionController
    if (typeof controller?.list !== 'function') return []
    const signal = AbortSignal.timeout(listTimeoutMs)
    let result
    try {
      result = await controller.list({}, signal)
    } catch (error) {
      // Signature skew: retry without a signal before giving up.
      try {
        result = await controller.list()
      } catch (retryError) {
        warn(`telegram-bridge: session list failed: ${errorMessage(retryError ?? error)}`)
        return []
      }
    }
    const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
    return items.filter((item) => item !== null && typeof item === 'object')
  }

  /**
   * Map one raw list row into the bridge's session shape.
   * @param {object} row - `sessionController.list()` row.
   * @param {object | undefined} project - project the row was filtered by, when any.
   * @returns {{ sessionId: string, title: string, cwd: string | undefined, running: boolean, updatedAt: number }} session row.
   */
  function sessionRowOf(row, project) {
    const sessionId = String(row.sessionId ?? row.id ?? '')
    const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : project?.path
    let running = row.running === true
    if (row.running === undefined) {
      // Older/simplified hosts omit `running`; an agent lookup is cheap.
      try {
        running = ctx?.agents?.get?.(sessionId)?.status === 'running'
      } catch {
        running = false
      }
    }
    return {
      sessionId,
      title: titleOf(row, ctx),
      cwd,
      running,
      updatedAt: Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : 0,
    }
  }

  /**
   * List sessions, newest first, optionally scoped to one project.
   *
   * Membership is decided by the session's canonical `cwd`, which is how the
   * Desktop profile groups sessions into workspaces; the workspace entity's
   * `sessionIds` is a secondary source for rows that carry no `cwd`.
   *
   * @param {{ projectId?: string | null, limit?: number }} [query] - optional scope and cap.
   * @returns {Promise<Array<{ sessionId: string, title: string, cwd: string | undefined, running: boolean, updatedAt: number }>>} sessions.
   */
  async function listSessions(query = {}) {
    const projectId = query?.projectId === undefined || query?.projectId === null ? undefined : String(query.projectId)
    const project = projectId === undefined ? undefined : workspaceEntity(projectId)
    const projectPath = project?.path ?? (await resolveProject(projectId ?? ''))?.path
    const memberIds = new Set(
      Array.isArray(project?.sessionIds) ? project.sessionIds.map((id) => String(id)) : [],
    )
    const rows = await rawSessionRows()
    const sessions = []
    for (const row of rows) {
      try {
        if (isSubagentRow(row)) continue
        const shaped = sessionRowOf(row, projectId === undefined ? undefined : { id: projectId, path: projectPath })
        if (shaped.sessionId === '') continue
        if (projectId !== undefined) {
          const inProject = (projectPath !== undefined && samePath(shaped.cwd, projectPath)) || memberIds.has(shaped.sessionId)
          if (!inProject) continue
        }
        sessions.push(shaped)
      } catch (error) {
        // One malformed row must not fail the whole listing.
        debug(`telegram-bridge: skipping unreadable session row: ${errorMessage(error)}`)
      }
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
    const limit = Number.isFinite(query?.limit) && Number(query.limit) > 0 ? Math.floor(Number(query.limit)) : DEFAULT_LIST_LIMIT
    return sessions.slice(0, limit)
  }

  /**
   * List the sessions a reference is resolved against: the current project's
   * sessions when a project is selected, otherwise every visible session.
   * @returns {Promise<object[]>} scoped session rows.
   */
  async function scopedSessions() {
    const project = currentProject()
    return listSessions(project === null ? { limit: DEFAULT_LIST_LIMIT } : { projectId: project.id, limit: DEFAULT_LIST_LIMIT })
  }

  /**
   * Resolve a session reference.
   *
   * Accepted forms, in order: a 1-based index into the current (optionally
   * project-filtered) list, a full session id, or a unique id prefix. An
   * ambiguous prefix resolves to undefined instead of guessing.
   *
   * @param {string | number} ref - index, full id, or id prefix.
   * @returns {Promise<object | undefined>} session row or undefined.
   */
  async function resolveSession(ref) {
    const text = String(ref ?? '').trim()
    if (text === '') return undefined
    if (/^\d+$/.test(text)) {
      const index = Number(text)
      const scoped = await scopedSessions()
      if (Number.isInteger(index) && index >= 1 && index <= scoped.length) return scoped[index - 1]
      return undefined
    }
    const all = await listSessions({ limit: DEFAULT_LIST_LIMIT })
    const exact = all.find((session) => session.sessionId === text)
    if (exact !== undefined) return exact
    const prefixed = all.filter((session) => session.sessionId.startsWith(text))
    if (prefixed.length === 1) return prefixed[0]
    if (prefixed.length > 1) {
      debug(`telegram-bridge: session reference "${text}" is ambiguous (${prefixed.length} matches)`)
      return undefined
    }
    // Fall back to the live session store, which can know an id the list missed.
    try {
      const live = ctx?.sessions?.get?.(text)
      if (live !== undefined && live !== null) {
        const header = live.header ?? {}
        return {
          sessionId: String(live.id ?? header.id ?? text),
          title: titleOf({ sessionId: String(live.id ?? text) }, ctx),
          cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
          running: ctx?.agents?.get?.(String(live.id ?? text))?.status === 'running',
          updatedAt: Number.isFinite(header.createdAt) ? Number(header.createdAt) : 0,
        }
      }
    } catch {
      // A store probe is best-effort.
    }
    return undefined
  }

  /**
   * Create a session in a project (or in the Host's default directory).
   *
   * `workspaceId` is passed rather than `cwd`: the controller accepts exactly
   * one of the two, and the workspace form also attaches the new session to the
   * project. Failures reject, because the operator asked for this and the bot
   * shows the message.
   *
   * @param {{ projectId?: string | null }} [request] - target project.
   * @returns {Promise<{ sessionId: string, cwd?: string }>} the new session identity.
   */
  async function createSession(request = {}) {
    const controller = ctx?.sessionController
    if (typeof controller?.create !== 'function') throw new Error('session creation is unavailable: this Host mounts no session controller')
    const projectId = request?.projectId === undefined || request?.projectId === null ? undefined : String(request.projectId)
    let project
    let payload
    if (projectId === undefined) {
      payload = {}
    } else {
      project = (await resolveProject(projectId)) ?? (workspaceEntity(projectId) === undefined ? undefined : projectOf(workspaceEntity(projectId)))
      payload = { workspaceId: project?.id ?? projectId }
    }
    const created = await controller.create(payload)
    const sessionId = String(created?.sessionId ?? '')
    if (sessionId === '') throw new Error('the session controller returned no session id')
    const result = project?.path === undefined ? { sessionId } : { sessionId, cwd: project.path }
    if (project !== undefined) currentSessionRecord = { sessionId, title: '', cwd: project.path }
    return result
  }

  /**
   * Deliver one text prompt to a session.
   *
   * The prompt is admitted as a `followup` user message with a fresh
   * idempotency `requestId`; the controller resumes a cold session itself. This
   * method never throws: every failure becomes `{ ok: false, error }`.
   *
   * @param {string} sessionId - target session identity.
   * @param {string} text - prompt text.
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>} delivery outcome.
   */
  async function sendPrompt(sessionId, text) {
    const target = String(sessionId ?? '').trim()
    const content = typeof text === 'string' ? text : String(text ?? '')
    if (target === '') return { ok: false, error: 'no session selected' }
    if (content.trim() === '') return { ok: false, error: 'prompt is empty' }
    const controller = ctx?.sessionController
    if (typeof controller?.prompt !== 'function') return { ok: false, error: 'this Host mounts no session controller' }
    // `resolveAgent` reports a missing/resumable session without throwing; a
    // `{ error }` result is the documented failure form.
    if (typeof controller.resolveAgent === 'function') {
      try {
        const resolved = await controller.resolveAgent(target)
        if (resolved !== undefined && resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
          return { ok: false, error: errorMessage(resolved.error) }
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    }
    try {
      const signal = AbortSignal.timeout(promptTimeoutMs)
      const accepted = await controller.prompt(
        { sessionId: target, content: [{ type: 'text', text: content }], requestId: randomUUID(), mode: 'followup' },
        signal,
      )
      if (accepted === false) return { ok: false, error: 'the session controller rejected the prompt' }
      debug(`telegram-bridge: prompt accepted for session "${target}"`)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  /**
   * Cancel the active turn of one session, retaining its queued work.
   *
   * A session that is not attached has nothing to cancel; that is reported as
   * success (the "never throw for not found" rule) rather than as an error.
   *
   * @param {string} sessionId - target session identity.
   * @returns {Promise<void>} resolves once cancellation was requested.
   */
  async function cancel(sessionId) {
    const target = String(sessionId ?? '').trim()
    if (target === '') return
    const controller = ctx?.sessionController
    if (typeof controller?.cancel !== 'function') {
      warn('telegram-bridge: cancel is unavailable: this Host mounts no session controller')
      return
    }
    try {
      await controller.cancel({ sessionId: target })
    } catch (error) {
      if (isNotFound(error)) {
        debug(`telegram-bridge: nothing to cancel in session "${target}": ${errorMessage(error)}`)
        return
      }
      throw new Error(errorMessage(error))
    }
  }

  /**
   * Rename one session. Rejects with the Host's message when the title is
   * rejected, because the operator asked for this and sees the outcome.
   * @param {string} sessionId - target session identity.
   * @param {string} title - proposed title.
   * @returns {Promise<void>} resolves once the title was accepted.
   */
  async function renameSession(sessionId, title) {
    const target = String(sessionId ?? '').trim()
    const next = String(title ?? '').replace(/\s+/g, ' ').trim()
    if (target === '') throw new Error('no session selected')
    if (next === '') throw new Error('a title is required')
    const controller = ctx?.sessionController
    if (typeof controller?.rename !== 'function') throw new Error('renaming is unavailable: this Host mounts no session controller')
    try {
      const renamed = await controller.rename({ sessionId: target, title: next })
      const accepted = typeof renamed?.title === 'string' && renamed.title !== '' ? renamed.title : next
      if (currentSessionRecord?.sessionId === target) currentSessionRecord = { ...currentSessionRecord, title: accepted }
    } catch (error) {
      throw new Error(errorMessage(error))
    }
  }

  /**
   * Follow one session's live events.
   *
   * The watcher keeps its own per-turn accumulation, so `onAssistant` always
   * receives the full assistant text of the current turn (the bot renders it as
   * one growing message). Tool phases are reported as `tool/call` → `'start'`
   * and `tool/result` → `'end'`. Every callback is isolated: a throwing handler
   * in one watcher can neither break another watcher nor the Host's append.
   *
   * Watching a cold session is safe and meaningful: the first prompt resumes it
   * and its events then flow through the global `session/event` listener.
   *
   * @param {string} sessionId - session identity to follow.
   * @param {{
   *   onAssistant?: (text: string) => void,
   *   onTool?: (name: string, phase: 'start' | 'end') => void,
   *   onTurnEnd?: (reason: string) => void | Promise<void>,
   *   onError?: (message: string) => void,
   *   includeThinking?: boolean,
   * }} handlers - callbacks.
   * @returns {() => void} idempotent unsubscribe function.
   */
  function watchSession(sessionId, handlers = {}) {
    const target = String(sessionId ?? '').trim()
    const includeThinking = handlers.includeThinking === true
    /** Accumulated assistant text of the current turn. */
    let turnText = []
    /** Tool names by call id, so a result can report the tool it belongs to. */
    const callNames = new Map()
    /** Temporary id assigned to the call currently in flight, when unknown. */
    let lastToolName = ''
    let stopped = false
    const disposers = []

    /**
     * Invoke one handler, swallowing its exceptions.
     * @param {Function | undefined} handler - user callback.
     * @param {...unknown} args - arguments.
     * @returns {void}
     */
    function fire(handler, ...args) {
      if (typeof handler !== 'function') return
      try {
        const result = handler(...args)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(undefined, (error) => warn(`telegram-bridge: watcher callback failed for "${target}": ${errorMessage(error)}`))
        }
      } catch (error) {
        warn(`telegram-bridge: watcher callback failed for "${target}": ${errorMessage(error)}`)
      }
    }

    /**
     * Reset per-turn accumulation.
     * @returns {void}
     */
    function resetTurn() {
      turnText = []
      callNames.clear()
      lastToolName = ''
    }

    /**
     * Handle one committed session event.
     * @param {object} session - live session that committed the event.
     * @param {object} event - committed session event.
     * @returns {void}
     */
    function onSessionEvent(session, event) {
      if (stopped || event === null || typeof event !== 'object') return
      const id = String(session?.id ?? session?.sessionId ?? '')
      if (id !== target) return
      try {
        switch (event.type) {
          case 'turn/start': {
            resetTurn()
            break
          }
          case 'assistant/message': {
            const text = extractAssistantText(event, includeThinking)
            if (text.trim() === '') return
            turnText.push(text)
            fire(handlers.onAssistant, turnText.join('\n\n'))
            break
          }
          case 'tool/call': {
            const name = typeof event.data?.name === 'string' && event.data.name !== '' ? event.data.name : 'tool'
            if (typeof event.data?.callId === 'string') callNames.set(event.data.callId, name)
            lastToolName = name
            fire(handlers.onTool, name, 'start')
            break
          }
          case 'tool/result': {
            const callId = event.data?.message?.source?.callId ?? event.data?.callId
            const known = typeof callId === 'string' ? callNames.get(callId) : undefined
            const fallback = typeof event.data?.name === 'string' ? event.data.name : lastToolName
            const name = known ?? (fallback !== '' ? fallback : 'tool')
            if (typeof callId === 'string') callNames.delete(callId)
            fire(handlers.onTool, name, 'end')
            break
          }
          case 'turn/end': {
            const reason = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : 'completed'
            fire(handlers.onTurnEnd, reason)
            resetTurn()
            break
          }
          default:
            break
        }
      } catch (error) {
        // Unknown payload shapes must not escape into the Host's append path.
        warn(`telegram-bridge: watcher for "${target}" failed on event "${String(event?.type)}": ${errorMessage(error)}`)
      }
    }

    /**
     * Handle one agent-level failure for this session.
     * @param {{ agent?: { id?: string }, error?: unknown }} payload - `agent/error` payload.
     * @returns {void}
     */
    function onAgentError(payload) {
      if (stopped) return
      const id = String(payload?.agent?.id ?? payload?.sessionId ?? '')
      if (id !== target) return
      fire(handlers.onError, errorMessage(payload?.error))
    }

    /**
     * Register one listener, keeping its disposer.
     * @param {string} name - event name.
     * @param {Function} listener - listener function.
     * @param {object} [listenerOptions] - Cordis listener options.
     * @returns {void}
     */
    function listen(name, listener, listenerOptions) {
      if (stopped || typeof ctx?.on !== 'function') return
      try {
        const dispose = listenerOptions === undefined ? ctx.on(name, listener) : ctx.on(name, listener, listenerOptions)
        if (typeof dispose === 'function') disposers.push(dispose)
        else if (dispose !== undefined && dispose !== null) disposers.push(() => {})
      } catch (error) {
        warn(`telegram-bridge: cannot follow session "${target}": ${errorMessage(error)}`)
      }
    }

    listen('session/event', onSessionEvent, { global: true })
    listen('agent/error', onAgentError, { global: true })

    /**
     * Detach this watcher. Safe to call more than once.
     * @returns {void}
     */
    function unsubscribe() {
      if (stopped) return
      stopped = true
      resetTurn()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A disposer that fails must not break teardown.
        }
      }
      watchers.delete(unsubscribe)
    }

    if (target !== '') watchers.add(unsubscribe)
    return unsubscribe
  }

  /**
   * Read the selected project. Synchronous by contract: the bot renders the
   * `/status` panel from it on every update.
   * @returns {{ id: string, title: string, path: string } | null} project or null.
   */
  function currentProject() {
    if (currentProjectId === null) return null
    const entity = workspaceEntity(currentProjectId)
    if (entity === undefined) return null
    return publicProject(projectOf(entity))
  }

  /**
   * Select a project; `null` clears the selection.
   * @param {string | null | undefined} id - workspace id.
   * @returns {void}
   */
  function setCurrentProject(id) {
    const next = id === null || id === undefined ? '' : String(id).trim()
    currentProjectId = next === '' ? null : next
  }

  /**
   * Read the selected session. Synchronous and cached, because the bot asks for
   * it on every update (and on every streamed edit) without awaiting.
   * @returns {{ sessionId: string, title: string, cwd?: string } | null} session or null.
   */
  function currentSession() {
    if (currentSessionRecord === null) return null
    return {
      sessionId: currentSessionRecord.sessionId,
      title: currentSessionRecord.title ?? '',
      ...(currentSessionRecord.cwd === undefined ? {} : { cwd: currentSessionRecord.cwd }),
    }
  }

  /**
   * Select a session, by record or by plain id; `null` clears the selection.
   * @param {{ sessionId?: string, title?: string, cwd?: string } | string | null | undefined} value - selection.
   * @returns {void}
   */
  function setCurrentSession(value) {
    if (value === null || value === undefined) {
      currentSessionRecord = null
      return
    }
    if (typeof value === 'string') {
      const sessionId = value.trim()
      currentSessionRecord = sessionId === '' ? null : { sessionId, title: currentSessionRecord?.sessionId === sessionId ? currentSessionRecord.title : '' }
      return
    }
    const sessionId = String(value.sessionId ?? '').trim()
    if (sessionId === '') {
      currentSessionRecord = null
      return
    }
    currentSessionRecord = {
      sessionId,
      title: typeof value.title === 'string' ? value.title : '',
      ...(typeof value.cwd === 'string' && value.cwd !== '' ? { cwd: value.cwd } : {}),
    }
  }

  /**
   * Describe the Host this bridge is attached to.
   * @returns {{ hostname: string, dshVersion?: string, cwd: string }} host identity.
   */
  function info() {
    const version = resolveVersion(ctx, options)
    return {
      hostname: hostname(),
      ...(version === undefined ? {} : { dshVersion: version }),
      cwd: process.cwd(),
    }
  }

  /**
   * Detach every watcher this bridge created. Extra convenience for the plugin's
   * Cordis disposer; not part of the bot-facing contract.
   * @returns {void}
   */
  function dispose() {
    for (const unsubscribe of [...watchers]) unsubscribe()
    watchers.clear()
  }

  return {
    listProjects,
    resolveProject,
    createProject,
    listSessions,
    resolveSession,
    createSession,
    sendPrompt,
    cancel,
    renameSession,
    watchSession,
    currentProject,
    setCurrentProject,
    currentSession,
    setCurrentSession,
    info,
    dispose,
  }
}

/**
 * Pure helpers exposed for unit tests. They have no state and no Host access.
 */
export const internals = {
  errorMessage,
  isNotFound,
  normalizePath,
  samePath,
  sameName,
  projectOf,
  publicProject,
  blockText,
  extractAssistantText,
  titleOf,
  isSubagentRow,
}

export default createSessionBridge
