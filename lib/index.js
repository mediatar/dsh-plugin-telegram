/**
 * dsh-plugin-telegram — drive DeepSeek Harness sessions from Telegram.
 *
 * Host-side plugin. It mounts a long-polling Bot API client next to the Harness
 * Host services and exposes project/session control plus prompt delivery. It
 * works in any profile that composes the Web Host (Desktop, `dsh web`), because
 * everything it needs (`sessionController`, `workspaceController`,
 * `workspaceRegistry`, `sessions`, `agents`) lives on the Host.
 *
 * The row is inert until a token is configured: without `token` (or
 * `DSH_TELEGRAM_BOT_TOKEN`) the plugin logs one line and never dials out.
 *
 * @module dsh-plugin-telegram
 */

import { booleanField, numberArrayField, numberField, objectField, stringField } from './config-schema.js'
import { createBot, createPoller } from './bot.js'
import { createSessionBridge } from './session-bridge.js'
import { createTelegramApi } from './telegram-api.js'

/** Cordis plugin name. */
export const name = 'telegram-bot'

/**
 * Host services this plugin requires before it starts.
 *
 * Cordis resolves an `inject` list as "wait until these exist"; anything
 * optional is read through `ctx.get()` in {@link serviceFacade} instead, so a
 * minimal Host composition can still mount the row without hanging the profile.
 */
export const inject = ['sessionController', 'workspaceRegistry', 'sessions']

/**
 * Build the context facade handed to the session bridge.
 *
 * The bridge is a plain module (and is unit-tested with fakes), so it reads its
 * dependencies as ordinary properties. Cordis only permits that for injected
 * names, therefore the facade resolves every service through `ctx.get()` and
 * forwards events, which keeps the bridge independent of Cordis internals.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {object} facade exposing services, `on`, `effect` and `logger`.
 */
function serviceFacade(ctx) {
  /**
   * Read one optional service without making it a load-time requirement.
   * @param {string} name - Cordis service key.
   * @returns {any} the service, or undefined when absent.
   */
  const read = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  return {
    sessionController: read('sessionController'),
    workspaceController: read('workspaceController'),
    workspaceRegistry: read('workspaceRegistry'),
    sessions: read('sessions'),
    agents: read('agents'),
    sessionProjections: read('sessionProjections'),
    sessionTitle: read('sessionTitle'),
    logger: ctx.logger,
    on: (...args) => ctx.on(...args),
    effect: (...args) => ctx.effect(...args),
    get: (name) => read(name),
  }
}

/**
 * Plugin configuration.
 *
 * `token` has no default on purpose: an empty default would make a typo look
 * like a valid configuration, while an absent value documents intent.
 */
export const Config = objectField({
  token: stringField({
    description: 'Telegram bot token from @BotFather. Falls back to $DSH_TELEGRAM_BOT_TOKEN.',
    required: false,
  }),
  allowedUsers: numberArrayField({
    default: [],
    description: 'Telegram numeric user ids allowed to drive the bot. Empty means "anyone who finds the bot".',
  }),
  proxy: stringField({
    description: 'Optional proxy: http://host:port, https://host:port, socks5://user:pass@host:port. Falls back to $DSH_TELEGRAM_PROXY.',
    required: false,
  }),
  baseUrl: stringField({
    description: 'Bot API origin. Defaults to https://api.telegram.org (override for a local Bot API server or tests).',
    required: false,
  }),
  pollTimeoutSeconds: numberField({
    step: 1,
    min: 0,
    max: 50,
    default: 25,
    description: 'Long-poll timeout handed to getUpdates, in seconds.',
  }),
  requestTimeoutMs: numberField({
    step: 1,
    min: 1_000,
    max: 600_000,
    default: 60_000,
    description: 'Per-request Bot API timeout, in milliseconds.',
  }),
  stream: booleanField({
    default: true,
    description: 'Mirror assistant output back into the chat while a turn runs.',
  }),
  notifyTools: booleanField({
    default: false,
    description: 'Show the currently running tool inside the streamed reply.',
  }),
  markdown: booleanField({
    default: true,
    description: 'Render replies with Telegram Markdown. Disable if the bot mangles formatting.',
  }),
})

/**
 * Resolve one string setting from configuration, then the environment.
 * @param {string | undefined} configured - value from the profile patch.
 * @param {string} variable - environment variable name.
 * @returns {string | undefined} the resolved value, or undefined when unset.
 */
function resolveSetting(configured, variable) {
  const fromConfig = typeof configured === 'string' ? configured.trim() : ''
  if (fromConfig !== '') return fromConfig
  const fromEnv = process.env[variable]
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : undefined
}

/**
 * Parse a comma-separated id list from the environment.
 * @param {string | undefined} raw - raw environment value.
 * @returns {number[]} valid numeric ids.
 */
function parseUserIds(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[,\s]+/)
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value !== 0)
}

/**
 * Report one operator-facing message.
 *
 * Cordis's `ctx.logger` is not rendered by the `dsh` CLI, so a plugin whose main
 * failure mode is "the network is blocked" would fail silently. Configuration
 * and reachability outcomes therefore go to stderr as well, which the CLI does
 * show. Routine per-update chatter stays on `ctx.logger` only.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {'info' | 'warn' | 'error'} level - severity.
 * @param {string} message - text without a trailing newline.
 * @returns {void}
 */
function report(ctx, level, message) {
  try {
    ctx.logger?.[level]?.(message)
  } catch {
    // A broken logger must not break startup.
  }
  try {
    process.stderr.write(`telegram-bot: ${message}\n`)
  } catch {
    // stderr can be closed in a detached host; the logger already had it.
  }
}

/**
 * Start one bot instance and return its disposer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated configuration.
 * @returns {Promise<() => Promise<void>>} a disposer that stops polling.
 */
export async function startBot(ctx, config) {
  const token = resolveSetting(config.token, 'DSH_TELEGRAM_BOT_TOKEN')
  if (token === undefined) {
    report(
      ctx,
      'info',
      'no token configured — set `token` in the profile patch for plugin "telegram-bot" or export DSH_TELEGRAM_BOT_TOKEN. Bot stays off.',
    )
    return async () => {}
  }
  const proxy = resolveSetting(config.proxy, 'DSH_TELEGRAM_PROXY')
  const baseUrl = resolveSetting(config.baseUrl, 'DSH_TELEGRAM_BASE_URL')
  const allowedUsers = [
    ...(config.allowedUsers ?? []),
    ...parseUserIds(process.env.DSH_TELEGRAM_ALLOWED_USERS),
  ]
  const api = createTelegramApi({
    token,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(proxy === undefined ? {} : { proxy }),
    timeoutMs: config.requestTimeoutMs ?? 60_000,
    logger: ctx.logger,
  })

  const identity = await api.getMe().catch((error) => {
    report(ctx, 'error', `getMe failed — bot not started: ${error?.message ?? error}`)
    // A blackholed network usually surfaces as a timeout/abort rather than a
    // refusal, so the abort family must produce the proxy hint too.
    const unreachable =
      error?.cause?.code === 'ECONNREFUSED' ||
      error?.cause?.code === 'ABORT_ERR' ||
      /timed out|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|aborted|ABORT_ERR/i.test(
        `${error?.message ?? ''} ${error?.cause?.code ?? ''}`,
      )
    if (unreachable) {
      report(
        ctx,
        'error',
        'api.telegram.org looks unreachable from this host. Configure `proxy` (http:// or socks5://) for plugin "telegram-bot", or export DSH_TELEGRAM_PROXY.',
      )
    }
    return undefined
  })
  if (identity === undefined) return async () => {}

  const bridge = createSessionBridge(serviceFacade(ctx))
  // `allowedUsers` is the merged config + environment list, not the raw config
  // value: the schema default is empty, and dropping the merge here would
  // silently open the bot to every Telegram user.
  const bot = createBot({ api, bridge, config: { ...config, allowedUsers }, logger: ctx.logger })
  const poller = createPoller({
    api,
    bot,
    config: { pollTimeoutSeconds: config.pollTimeoutSeconds ?? 25 },
    logger: ctx.logger,
  })
  await api.setMyCommands(bot.commandMenu).catch((error) => {
    ctx.logger?.debug?.(`telegram-bot: setMyCommands failed: ${error?.message ?? error}`)
  })
  report(
    ctx,
    'info',
    `polling as @${identity.username ?? identity.id} (${
      allowedUsers.length === 0 ? 'open to any Telegram user — set allowedUsers' : `${allowedUsers.length} allowed user(s)`
    }${proxy === undefined ? '' : `, via proxy ${proxy.replace(/\/\/[^@/]*@/, '//***@')}`})`,
  )
  poller.start()

  // "Wherever it is open, there it works": mirror the session the user is
  // working in inside DSH into any chat that enabled /follow. The Host emits
  // `api-session/activity` for every accepted user prompt and
  // `api-session/status` when a session starts or stops running.
  const followActive = (sessionId) => {
    try {
      bot.followActiveSession(String(sessionId))
    } catch (error) {
      ctx.logger?.debug?.(`telegram-bot: auto-follow failed: ${error?.message ?? error}`)
    }
  }
  const offActivity = ctx.on('api-session/activity', followActive)
  const offStatus = ctx.on('api-session/status', (sessionId, running) => {
    if (running === true) followActive(sessionId)
  })

  return async () => {
    offActivity?.()
    offStatus?.()
    bot.stop()
    await poller.stop()
    ctx.logger?.info?.('telegram-bot: stopped')
  }
}

/**
 * Cordis plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = Config(config ?? {})
  let disposed = false
  // Cordis tears the plugin down synchronously; a running long poll is async, so
  // the disposer is registered as soon as the bot is ready and also guards
  // against an unload that happens mid-startup.
  const starting = startBot(ctx, resolved).catch((error) => {
    report(ctx, 'error', `failed to start: ${error?.message ?? error}`)
    return async () => {}
  })
  ctx.effect(() => () => {
    disposed = true
    return starting.then((dispose) => (disposed ? dispose() : undefined))
  }, 'telegram-bot.lifecycle')
}

export default { name, inject, Config, apply }
