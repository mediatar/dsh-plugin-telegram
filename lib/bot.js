/**
 * Telegram update router: commands, inline keyboards and message rendering.
 *
 * The router is deliberately transport-agnostic: it receives one Telegram
 * `Update` object and talks to the outside world only through the injected
 * `api` (Bot API client) and `bridge` (DSH session facade). That makes every
 * flow testable against a mocked Bot API without a live Harness.
 *
 * @module dsh-plugin-telegram/bot
 */

import { splitText } from './telegram-api.js'

/** Maximum rows Telegram renders for a slash-command menu. */
const COMMAND_MENU = [
  { command: 'start', description: 'Show the control panel' },
  { command: 'projects', description: 'List and choose projects' },
  { command: 'sessions', description: 'List and choose sessions' },
  { command: 'new', description: 'Create a session in the current project' },
  { command: 'use', description: 'Switch session by number or id' },
  { command: 'follow', description: 'Follow the session active in DSH' },
  { command: 'status', description: 'Show current project and session' },
  { command: 'cancel', description: 'Stop the running turn' },
  { command: 'stop', description: 'Alias for /cancel' },
  { command: 'rename', description: 'Rename the current session' },
  { command: 'help', description: 'How to use this bot' },
]

/** Preview length for an assistant reply before streaming edits begin. */
const STREAM_PREVIEW_CHARS = 600
/** Minimum delay between two streaming message edits. */
const STREAM_EDIT_INTERVAL_MS = 2_500

/**
 * Render one entity name for a single line of text.
 * @param {string | undefined} value - raw value.
 * @param {number} [limit] - maximum rendered length.
 * @returns {string} single-line, length-bounded text.
 */
export function oneLine(value, limit = 60) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * Render an epoch-millisecond timestamp as a short relative age.
 * @param {number | undefined} time - epoch milliseconds.
 * @param {number} [now] - reference time.
 * @returns {string} e.g. `5m ago`, or an empty string.
 */
export function relativeAge(time, now = Date.now()) {
  if (!Number.isFinite(time)) return ''
  const delta = Math.max(0, now - time)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Shorten a session id for display; the full id stays available through /status.
 * @param {string} sessionId - durable session identity.
 * @returns {string} display form.
 */
export function shortSessionId(sessionId) {
  const text = String(sessionId ?? '')
  return text.length <= 12 ? text : text.slice(0, 12)
}

/**
 * Build the inline keyboard that mirrors the numbered session list.
 * @param {Array<{ sessionId: string, title: string, running?: boolean }>} sessions - rendered sessions.
 * @param {string | null} currentSessionId - currently selected session.
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }} reply markup.
 */
export function sessionKeyboard(sessions, currentSessionId) {
  const rows = sessions.slice(0, 20).map((session, index) => [
    {
      text: `${session.sessionId === currentSessionId ? '•' : ' '} ${index + 1}. ${oneLine(session.title || 'Untitled', 32)}${session.running ? ' ⏳' : ''}`.trim(),
      callback_data: `s:${index + 1}`,
    },
  ])
  return { inline_keyboard: rows }
}

/**
 * Build the inline keyboard that mirrors the project list.
 * @param {Array<{ id: string, title: string, sessionCount: number }>} projects - rendered projects.
 * @param {string | null} currentProjectId - currently selected project.
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }} reply markup.
 */
export function projectKeyboard(projects, currentProjectId) {
  const rows = projects.slice(0, 30).map((project, index) => [
    {
      text: `${project.id === currentProjectId ? '•' : ' '} ${index + 1}. ${oneLine(project.title, 28)} (${project.sessionCount})`.trim(),
      callback_data: `p:${project.id}`,
    },
  ])
  rows.push([{ text: '↻ Refresh', callback_data: 'p:refresh' }, { text: '＋ New session', callback_data: 'new' }])
  return { inline_keyboard: rows }
}

/**
 * Render `/status` for the current selection.
 * @param {object} state - `{ project, session, host }` snapshot.
 * @returns {string} message text.
 */
export function renderStatus(state) {
  const { project, session, running, host } = state
  const lines = ['📊 *Status*', '']
  lines.push(project === null || project === undefined
    ? '📁 Project: _not selected_'
    : `📁 Project: *${oneLine(project.title, 40)}*\n\`${project.path}\``)
  lines.push(session === null || session === undefined
    ? '💬 Session: _not selected_'
    : `💬 Session: *${oneLine(session.title || 'Untitled', 40)}*\n\`${session.sessionId}\`${running ? '\n⏳ running' : ''}`)
  if (host?.hostname) lines.push('', `🖥 Host: \`${host.hostname}\``)
  return lines.join('\n')
}

/**
 * Render the `/start` panel.
 * @param {{ host?: { hostname?: string, dshVersion?: string } }} [info] - host info.
 * @param {string | null} [currentSessionId] - selected session.
 * @returns {string} message text.
 */
export function renderHelp(info, currentSessionId = null) {
  const lines = [
    '🤖 *DeepSeek Harness → Telegram*',
    '',
    'Pick a project, pick a session, then just type — your text goes straight to the agent.',
    '',
    '*Projects*',
    '/projects — choose a project (inline buttons)',
    '',
    '*Sessions*',
    '/sessions — choose a session in the current project',
    '/new — create a new session in the current project',
    '/use <n|id> — switch to a session by number or id',
    '/follow [off] — follow whichever session you are working in inside DSH',
    '/status — show project, session and running state',
    '/rename <title> — rename the current session',
    '/cancel — stop the running turn (alias: /stop)',
    '',
    'Anything else you send is delivered as a prompt to the current session.',
  ]
  if (currentSessionId) lines.push('', `Selected session: \`${shortSessionId(currentSessionId)}\``)
  if (info?.hostname) lines.push('', `Host: \`${info.hostname}\``)
  return lines.join('\n')
}

/**
 * Create the update router.
 * @param {{
 *   api: ReturnType<typeof import('./telegram-api.js').createTelegramApi>,
 *   bridge: object,
 *   config?: { allowedUsers?: number[], markdown?: boolean, stream?: boolean, notifyTools?: boolean },
 *   logger?: { info?: Function, warn?: Function, debug?: Function, error?: Function },
 * }} options - router dependencies.
 * @returns {object} router with `handleUpdate`, `start`, `stop` and `sendToChat`.
 */
export function createBot(options) {
  const { api, bridge, config = {}, logger } = options
  const allowedUsers = new Set((config.allowedUsers ?? []).map(Number).filter(Number.isFinite))
  const notifyTools = config.notifyTools ?? false
  /**
   * Render Markdown only when configured. The renderers emit MarkdownV2-ish
   * text (`*bold*`, `` `code` ``); with `markdown: false` the same text is sent
   * as plain text, so users who see literal asterisks can turn it off.
   */
  const renderMarkup = config.markdown === false ? {} : { parse_mode: 'Markdown' }
  /** Session ids whose assistant output is forwarded to a chat. */
  const watchers = new Map()
  /** Last rendered index of a session list per chat, so numeric replies resolve. */
  const lastSessionList = new Map()
  /** Last rendered project list per chat. */
  const lastProjectList = new Map()
  /** Chats that asked to follow whatever session the user works in. */
  const autoFollowChats = new Set()
  let stopped = false

  /**
   * Send one plain-text message, splitting oversized text.
   * @param {string | number} chatId - destination chat.
   * @param {string} text - message text.
   * @param {object} [extra] - extra sendMessage options.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function send(chatId, text, extra = {}) {
    const chunks = splitText(text, 4000)
    for (const chunk of chunks) {
      try {
        await api.sendMessage(chatId, chunk, { disable_web_page_preview: true, ...renderMarkup, ...extra })
      } catch (error) {
        logger?.warn?.(`telegram: sendMessage failed for chat ${chatId}: ${error.message}`)
        if (error?.errorCode === 403) throw error
        // A Markdown parse failure is recoverable: resend the same text plainly
        // so a stray `*` or `_` in an agent reply cannot swallow the message.
        if (error?.errorCode === 400 && /parse entities|can't parse/i.test(String(error?.description ?? ''))) {
          try {
            await api.sendMessage(chatId, chunk, { disable_web_page_preview: true, ...extra })
          } catch (retryError) {
            logger?.warn?.(`telegram: plain-text resend failed for chat ${chatId}: ${retryError.message}`)
          }
          continue
        }
        return
      }
    }
  }

  /**
   * Render the project list for one chat.
   * @param {string | number} chatId - destination chat.
   * @param {string} [prefix] - text placed above the list.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function sendProjects(chatId, prefix = '📁 *Projects*') {
    const projects = await bridge.listProjects()
    if (projects.length === 0) {
      await send(chatId, `${prefix}\n\nNo projects yet. Add one in the DSH sidebar, then /projects again.`)
      return
    }
    lastProjectList.set(String(chatId), projects)
    const current = bridge.currentProject()
    const lines = [prefix, '']
    projects.forEach((project, index) => {
      lines.push(`${project.id === current?.id ? '•' : ' '} ${index + 1}. *${oneLine(project.title, 40)}*`)
      lines.push(`   \`${project.path}\` · ${project.sessionCount} session${project.sessionCount === 1 ? '' : 's'}`)
    })
    await send(chatId, lines.join('\n'), { reply_markup: projectKeyboard(projects, current?.id ?? null) })
  }

  /**
   * Render the session list for the current project.
   * @param {string | number} chatId - destination chat.
   * @param {string} [prefix] - text placed above the list.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function sendSessions(chatId, prefix = '💬 *Sessions*') {
    const project = bridge.currentProject()
    const sessions = await bridge.listSessions({ projectId: project?.id, limit: 25 })
    lastSessionList.set(String(chatId), { project, sessions })
    if (sessions.length === 0) {
      await send(chatId, `${prefix}\n\nNo sessions in ${project ? `*${oneLine(project.title, 40)}*` : 'this project'} yet. Send /new to create one.`)
      return
    }
    const current = bridge.currentSession()
    const lines = [prefix, project ? `in *${oneLine(project.title, 40)}*` : '', '']
    sessions.forEach((session, index) => {
      const marker = session.sessionId === current ? '•' : ' '
      lines.push(`${marker} ${index + 1}. *${oneLine(session.title || 'Untitled', 44)}*${session.running ? ' ⏳' : ''}`)
      lines.push(`   \`${shortSessionId(session.sessionId)}\` · ${relativeAge(session.updatedAt) || 'no activity'}`)
    })
    lines.push('', 'Tap a button or send /use <number>.')
    await send(chatId, lines.join('\n'), { reply_markup: sessionKeyboard(sessions, current) })
  }

  /**
   * Attach a live watcher that mirrors assistant output into the chat.
   * @param {string | number} chatId - destination chat.
   * @param {string} sessionId - watched session.
   * @returns {void}
   */
  function watch(chatId, sessionId) {
    if (config.stream === false) return
    const existing = watchers.get(sessionId)
    if (existing?.chatId === String(chatId)) return
    existing?.stop()
    // A chat follows exactly one session; drop watchers for other sessions so a
    // switch cannot leave an orphaned subscription behind.
    for (const [watchedId, entry] of watchers) {
      if (entry.chatId === String(chatId) && watchedId !== sessionId) entry.stop()
    }
    const chatKey = String(chatId)
    let pending = ''
    let messageId
    let lastEdit = 0
    let flushTimer
    let toolLine = ''

    /**
     * Push the accumulated text into the chat as one growing message.
     * @param {boolean} force - bypass the edit interval.
     * @returns {Promise<void>} resolves after the edit settles.
     */
    const flush = async (force) => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      const text = `${pending}${toolLine}`
      if (text.trim() === '') return
      const now = Date.now()
      if (!force && now - lastEdit < STREAM_EDIT_INTERVAL_MS) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined
          void flush(true)
        }, STREAM_EDIT_INTERVAL_MS)
        return
      }
      lastEdit = now
      const body = splitText(text.slice(-3_600), 3_600)[0]
      try {
        if (messageId === undefined) {
          const sent = await api.sendMessage(chatId, body, { disable_web_page_preview: true, ...renderMarkup })
          messageId = sent?.message_id
        } else {
          await api.editMessageText(chatId, messageId, body, { disable_web_page_preview: true, ...renderMarkup })
        }
      } catch (error) {
        const description = String(error?.description ?? error?.message ?? '')
        // A growing agent reply can easily contain unbalanced `*`/`_`; dropping
        // Markdown for the rest of this stream keeps the text visible.
        if (error?.errorCode === 400 && /parse entities|can't parse/i.test(description)) {
          try {
            if (messageId === undefined) {
              const sent = await api.sendMessage(chatId, body, { disable_web_page_preview: true })
              messageId = sent?.message_id
            } else {
              await api.editMessageText(chatId, messageId, body, { disable_web_page_preview: true })
            }
            return
          } catch (retryError) {
            logger?.debug?.(`telegram: plain stream update failed: ${retryError.message}`)
            return
          }
        }
        // "message is not modified" is a normal outcome of a throttled stream.
        if (!description.includes('message is not modified')) {
          logger?.debug?.(`telegram: stream update failed: ${error.message}`)
        }
      }
    }

    let unsubscribe

    /**
     * Detach this watcher exactly once: drop the bot's reference and release the
     * bridge subscription it owns. A turn end, an agent error, or a chat switch
     * all funnel here so a finished stream cannot keep firing into a dead
     * closure.
     * @returns {void}
     */
    const detach = () => {
      if (watchers.get(sessionId)?.stop === unsubscribe) watchers.delete(sessionId)
      const release = unsubscribe
      unsubscribe = undefined
      release?.()
    }

    unsubscribe = bridge.watchSession(sessionId, {
      onAssistant: (text) => {
        if (stopped) return
        pending = text.length > 12_000 ? text.slice(-12_000) : text
        void flush(false)
      },
      onTool: (name, phase) => {
        if (stopped || !notifyTools) return
        toolLine = phase === 'start' ? `\n\n🔧 ${oneLine(name, 40)}…` : ''
        void flush(false)
      },
      onTurnEnd: async (reason) => {
        if (stopped) return
        await flush(true)
        detach()
        if (reason !== undefined && reason !== 'completed' && reason !== 'stop') {
          await send(chatId, `⚠️ Turn ended: ${oneLine(reason, 60)}`).catch(() => {})
        }
      },
      onError: (message) => {
        detach()
        void send(chatId, `❌ Agent error: ${oneLine(message, 300)}`).catch(() => {})
      },
    })
    watchers.set(sessionId, { chatId: chatKey, stop: () => detach() })
  }

  /**
   * Resolve the chat's last numbered session list, if any.
   * @param {string} chatKey - chat identity.
   * @param {string} ref - number or reference text.
   * @returns {object | undefined} the chosen session.
   */
  function fromLastList(chatKey, ref) {
    const cached = lastSessionList.get(chatKey)
    if (cached === undefined) return undefined
    const index = Number(ref)
    if (!Number.isInteger(index) || index < 1) return undefined
    return cached.sessions[index - 1]
  }

  /**
   * Switch the chat's current session and start mirroring it.
   * @param {string} chatKey - chat identity.
   * @param {string | number} chatId - chat id for replies.
   * @param {string} ref - number or reference.
   * @returns {Promise<boolean>} whether the switch succeeded.
   */
  async function useSession(chatKey, chatId, ref) {
    const listed = fromLastList(chatKey, ref)
    const session = listed ?? (await bridge.resolveSession(ref))
    if (session === undefined) {
      await send(chatId, `Session \`${oneLine(ref, 40)}\` was not found. Send /sessions to see the list.`)
      return false
    }
    bridge.setCurrentSession(session.sessionId)
    watch(chatId, session.sessionId)
    await send(chatId, `✅ Now sending to *${oneLine(session.title || 'Untitled', 60)}*\n\`${session.sessionId}\``, {
      reply_markup: { inline_keyboard: [[{ text: '📊 Status', callback_data: 'status' }, { text: '⏹ Stop', callback_data: 'cancel' }]] },
    })
    return true
  }

  /**
   * Handle `/new`.
   * @param {string | number} chatId - destination chat.
   * @returns {Promise<void>} resolves when reported.
   */
  async function createSession(chatId) {
    const project = bridge.currentProject()
    if (project === undefined || project === null) {
      await send(chatId, '📁 Choose a project first: /projects')
      return
    }
    try {
      const created = await bridge.createSession({ projectId: project.id })
      bridge.setCurrentSession(created.sessionId)
      watch(chatId, created.sessionId)
      await send(chatId, `🆕 New session in *${oneLine(project.title, 40)}*\n\`${created.sessionId}\`${created.cwd ? `\n\`${created.cwd}\`` : ''}\n\nJust type your first message.`)
    } catch (error) {
      await send(chatId, `❌ Could not create a session: ${oneLine(error?.message ?? error, 300)}`)
    }
  }

  /**
   * Deliver a plain-text prompt to the current session.
   * @param {string | number} chatId - destination chat.
   * @param {string} text - prompt text.
   * @returns {Promise<void>} resolves when acknowledged.
   */
  async function deliverPrompt(chatId, text) {
    const session = bridge.currentSession()
    if (session === undefined || session === null) {
      await send(chatId, '💬 No session selected yet.\n\nUse /projects → pick a project → /sessions or /new.')
      return
    }
    watch(chatId, session.sessionId)
    const result = await bridge.sendPrompt(session.sessionId, text)
    if (result?.ok === false) {
      await send(chatId, `❌ Not delivered: ${oneLine(result.error ?? 'unknown error', 300)}`)
      return
    }
    void api.sendChatAction(chatId, 'typing').catch(() => {})
  }

  /**
   * Route one Telegram update.
   * @param {object} update - Bot API update object.
   * @returns {Promise<void>} resolves when handled.
   */
  async function handleUpdate(update) {
    if (stopped || update === undefined || update === null) return
    if (update.callback_query !== undefined) {
      await handleCallback(update.callback_query)
      return
    }
    const message = update.message ?? update.edited_message
    if (message === undefined) return
    const chatId = message.chat?.id
    if (chatId === undefined) return
    const userId = message.from?.id
    if (!authorized(userId)) {
      logger?.warn?.(`telegram: rejected user ${userId} (not in allowedUsers)`)
      await send(chatId, `⛔ Not authorized.\nYour Telegram user id is \`${userId}\`.`)
      return
    }
    const chatKey = String(chatId)
    const text = String(message.text ?? message.caption ?? '').trim()
    if (text === '') {
      await send(chatId, 'Only text messages are supported for now.')
      return
    }
    if (text.startsWith('/')) {
      await handleCommand(chatKey, chatId, text)
      return
    }
    await deliverPrompt(chatId, text)
  }

  /**
   * Check the configured allow-list.
   * @param {number | undefined} userId - Telegram user id.
   * @returns {boolean} whether the user may operate the bot.
   */
  function authorized(userId) {
    if (allowedUsers.size === 0) return true
    return allowedUsers.has(Number(userId))
  }

  /**
   * Dispatch one slash command.
   * @param {string} chatKey - chat identity.
   * @param {string | number} chatId - destination chat.
   * @param {string} text - raw command text.
   * @returns {Promise<void>} resolves when handled.
   */
  async function handleCommand(chatKey, chatId, text) {
    const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text)
    const command = (match?.[1] ?? '').toLowerCase()
    const argument = (match?.[2] ?? '').trim()
    switch (command) {
      case 'start':
      case 'help': {
        const info = bridge.info?.() ?? {}
        await send(chatId, renderHelp(info, bridge.currentSession()))
        return
      }
      case 'projects':
      case 'p': {
        if (argument !== '') {
          await selectProject(chatKey, chatId, argument)
          return
        }
        await sendProjects(chatId)
        return
      }
      case 'sessions':
      case 's': {
        await sendSessions(chatId)
        return
      }
      case 'new': {
        await createSession(chatId)
        return
      }
      case 'use': {
        if (argument === '') {
          await send(chatId, 'Usage: /use <number|session-id>')
          return
        }
        await useSession(chatKey, chatId, argument)
        return
      }
      case 'follow': {
        const enabled = argument === '' ? true : !/^(off|stop|no|false|0)$/i.test(argument)
        setAutoFollow(chatId, enabled)
        await send(chatId, enabled
          ? '👀 Following the session that is active in DSH. It becomes current whenever you work in another one. Send /follow off to stop.'
          : '👀 Automatic following disabled. Use /sessions or /use to pick a session.')
        return
      }
      case 'status': {
        await sendStatus(chatId)
        return
      }
      case 'cancel':
      case 'stop': {
        await cancelRun(chatId)
        return
      }
      case 'rename': {
        const session = bridge.currentSession()
        if (session === undefined || session === null) {
          await send(chatId, 'Select a session first: /sessions')
          return
        }
        if (argument === '') {
          await send(chatId, 'Usage: /rename <new title>')
          return
        }
        try {
          await bridge.renameSession(session.sessionId, argument)
          await send(chatId, `✏️ Renamed to *${oneLine(argument, 60)}*`)
        } catch (error) {
          await send(chatId, `❌ Rename failed: ${oneLine(error?.message ?? error, 300)}`)
        }
        return
      }
      default: {
        await send(chatId, `Unknown command /${oneLine(command, 30)}. Send /help.`)
      }
    }
  }

  /**
   * Send the `/status` panel.
   * @param {string | number} chatId - destination chat.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function sendStatus(chatId) {
    const project = bridge.currentProject()
    const selected = bridge.currentSession()
    const session = selected === undefined || selected === null
      ? null
      : (await bridge.listSessions({ limit: 200 }).catch(() => []))
        .find((candidate) => candidate.sessionId === selected.sessionId) ?? selected
    const state = {
      project,
      session,
      running: session?.running === true,
      host: bridge.info?.() ?? {},
    }
    await send(chatId, renderStatus(state), {
      reply_markup: {
        inline_keyboard: [[
          { text: '📁 Projects', callback_data: 'p:refresh' },
          { text: '💬 Sessions', callback_data: 'sessions' },
          { text: '⏹ Stop', callback_data: 'cancel' },
        ]],
      },
    })
  }

  /**
   * Cancel the current session's running turn.
   * @param {string | number} chatId - destination chat.
   * @returns {Promise<void>} resolves when reported.
   */
  async function cancelRun(chatId) {
    const session = bridge.currentSession()
    if (session === undefined || session === null) {
      await send(chatId, 'Select a session first: /sessions')
      return
    }
    try {
      await bridge.cancel(session.sessionId)
      await send(chatId, '🛑 Cancellation requested.')
    } catch (error) {
      await send(chatId, `❌ Cancel failed: ${oneLine(error?.message ?? error, 300)}`)
    }
  }

  /**
   * Resolve a project reference and make it current.
   * @param {string} chatKey - chat identity.
   * @param {string | number} chatId - destination chat.
   * @param {string} ref - id, title, path or list number.
   * @returns {Promise<void>} resolves when reported.
   */
  async function selectProject(chatKey, chatId, ref) {
    const index = Number(ref)
    const listed = lastProjectList.get(chatKey)
    const project = Number.isInteger(index) && index >= 1
      ? (listed?.[index - 1] ?? (await bridge.listProjects())[index - 1])
      : await bridge.resolveProject(ref)
    if (project === undefined) {
      await send(chatId, `Project \`${oneLine(ref, 40)}\` was not found. Send /projects to see the list.`)
      return
    }
    applyProject(project)
    await send(chatId, `✅ Project *${oneLine(project.title, 60)}*\n\`${project.path}\``)
    await sendSessions(chatId)
  }

  /**
   * Set the current project, clearing a session from another project.
   * @param {{ id: string, title: string, path: string }} project - chosen project.
   * @returns {void}
   */
  function applyProject(project) {
    bridge.setCurrentProject(project.id)
    const session = bridge.currentSession()
    if (session !== undefined && session !== null) {
      const matches = (session.cwd ?? '') === project.path
      if (!matches) bridge.setCurrentSession(null)
    }
  }

  /**
   * Handle one inline-keyboard callback.
   * @param {object} query - Bot API callback query object.
   * @returns {Promise<void>} resolves when handled.
   */
  async function handleCallback(query) {
    const chatId = query.message?.chat?.id
    const data = String(query.data ?? '')
    const userId = query.from?.id
    try {
      if (!authorized(userId)) {
        await api.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true })
        return
      }
      const chatKey = chatId === undefined ? '' : String(chatId)
      const [kind, value] = [data.slice(0, data.indexOf(':') === -1 ? data.length : data.indexOf(':')), data.slice(data.indexOf(':') === -1 ? data.length : data.indexOf(':') + 1)]
      await api.answerCallbackQuery(query.id).catch(() => {})
      if (chatId === undefined) return
      if (kind === 'p' && value === 'refresh') {
        await sendProjects(chatId)
        return
      }
      if (kind === 'p') {
        const project = await bridge.resolveProject(value)
        if (project === undefined) {
          await send(chatId, 'Project is gone — refreshing the list.')
          await sendProjects(chatId)
          return
        }
        applyProject(project)
        await send(chatId, `✅ Project *${oneLine(project.title, 60)}*`)
        await sendSessions(chatId)
        return
      }
      if (kind === 's') {
        await useSession(chatKey, chatId, value)
        return
      }
      if (kind === 'new') {
        await createSession(chatId)
        return
      }
      if (kind === 'sessions') {
        await sendSessions(chatId)
        return
      }
      if (kind === 'status') {
        await sendStatus(chatId)
        return
      }
      if (kind === 'cancel') {
        await cancelRun(chatId)
        return
      }
      await send(chatId, `Unsupported action: ${oneLine(data, 40)}`)
    } catch (error) {
      logger?.warn?.(`telegram: callback handling failed: ${error.message}`)
      if (chatId !== undefined) await send(chatId, `❌ ${oneLine(error?.message ?? error, 300)}`).catch(() => {})
    }
  }

  /**
   * Enable or disable automatic following of the DSH-active session for a chat.
   * @param {string | number} chatId - chat identity.
   * @param {boolean} enabled - desired state.
   * @returns {void}
   */
  function setAutoFollow(chatId, enabled) {
    const key = String(chatId)
    if (enabled) autoFollowChats.add(key)
    else autoFollowChats.delete(key)
  }

  return {
    handleUpdate,
    send,
    sendStatus,
    sendProjects,
    sendSessions,
    /**
     * Mirror one session that became active in the DSH UI into every chat that
     * asked to follow the live session. Called by the plugin entry when the Host
     * reports activity, so the bot follows "wherever work is happening".
     * @param {string} sessionId - session that just became active.
     * @param {{ title?: string }} [meta] - optional display metadata.
     * @returns {void}
     */
    followActiveSession(sessionId, meta) {
      if (stopped || typeof sessionId !== 'string' || sessionId === '') return
      const session = bridge.currentSession()
      if (session?.sessionId === sessionId && autoFollowChats.size === 0) return
      bridge.setCurrentSession(sessionId)
      for (const chatId of autoFollowChats) watch(chatId, sessionId)
    },
    /**
     * Turn automatic following of the DSH-active session on or off for a chat.
     * @param {string | number} chatId - chat identity.
     * @param {boolean} enabled - desired state.
     * @returns {void}
     */
    setAutoFollow,
    /** Command menu pushed to Telegram for the `/` UI. */
    commandMenu: COMMAND_MENU,
    /** Stop mirroring and detach watchers. */
    stop() {
      stopped = true
      for (const watcher of watchers.values()) watcher.stop()
      watchers.clear()
      autoFollowChats.clear()
    },
    /** Expose the live watcher registry for tests. */
    get watcherCount() {
      return watchers.size
    },
  }
}

/**
 * Build the long-polling loop around a bot.
 * @param {{
 *   api: ReturnType<typeof import('./telegram-api.js').createTelegramApi>,
 *   bot: ReturnType<typeof createBot>,
 *   config: { pollTimeoutSeconds?: number },
 *   logger?: object,
 * }} options - loop dependencies.
 * @returns {{ start: () => void, stop: () => Promise<void>, flush: () => Promise<void> }} controller.
 */
export function createPoller(options) {
  const { api, bot, config = {}, logger } = options
  const timeout = Math.max(0, Math.min(50, config.pollTimeoutSeconds ?? 25))
  let offset = 0
  let running = false
  let controller
  let loop

  /**
   * Wait for one batch, dispatch it, advance the offset.
   * @param {number} waitSeconds - long-poll timeout.
   * @returns {Promise<void>} resolves after the batch settles.
   */
  async function pollOnce(waitSeconds) {
    const updates = await api.getUpdates({
      offset,
      timeout: waitSeconds,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      signal: controller.signal,
    })
    for (const update of updates ?? []) {
      if (controller.signal.aborted) return
      offset = Math.max(offset, Number(update.update_id) + 1)
      try {
        await bot.handleUpdate(update)
      } catch (error) {
        logger?.warn?.(`telegram: update ${update.update_id} failed: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Run the polling loop with backoff until stopped.
   * @returns {Promise<void>} resolves when the loop exits.
   */
  async function run() {
    let attempts = 0
    while (running) {
      const active = controller
      try {
        await pollOnce(timeout)
        attempts = 0
      } catch (error) {
        if (!running || active.signal.aborted) break
        attempts += 1
        const wait = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))
        logger?.warn?.(`telegram: polling failed (${error.message}); retrying in ${Math.round(wait / 1000)}s`)
        await sleep(wait)
      }
    }
  }

  return {
    start() {
      if (running) return
      running = true
      controller = new AbortController()
      loop = run().catch((error) => {
        logger?.error?.(`telegram: poller crashed: ${error?.message ?? error}`)
      })
    },
    async stop() {
      running = false
      controller?.abort()
      await loop?.catch(() => {})
    },
    /**
     * Drain updates without long polling (used at startup and in tests).
     * @returns {Promise<void>} resolves after the queued batch settles.
     */
    async flush() {
      if (controller === undefined || controller.signal.aborted) controller = new AbortController()
      await pollOnce(0)
    },
  }
}

/**
 * Sleep helper for backoff.
 * @param {number} ms - delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export { COMMAND_MENU, STREAM_PREVIEW_CHARS }
