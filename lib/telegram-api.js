/**
 * Minimal Telegram Bot API client with explicit proxy support.
 *
 * Zero dependencies on purpose: the plugin is installed into an arbitrary DSH
 * profile, and every extra npm package is an extra peer-resolution risk for the
 * embedded pnpm store. Node's own `https`, `net` and `tls` modules cover
 * everything the Bot API needs.
 *
 * Supported routes:
 *   - direct HTTPS (default)
 *   - `http://user:pass@host:port` HTTP proxy (via CONNECT for https targets)
 *   - `socks5://user:pass@host:port` and `socks5h://` SOCKS5 proxy
 *
 * @module dsh-plugin-telegram/telegram-api
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomBytes } from 'node:crypto'

/** Telegram refuses message text longer than this. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096
/** Bot API methods that must not be retried after a transport failure. */
const NON_IDEMPOTENT = new Set(['sendMessage', 'sendDocument', 'sendPhoto'])

const DEFAULT_BASE_URL = 'https://api.telegram.org'
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * One Bot API failure, either a transport error or an `ok:false` payload.
 */
export class TelegramApiError extends Error {
  /**
   * @param {string} message - human readable diagnostic.
   * @param {{ method?: string, errorCode?: number, description?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TelegramApiError'
    this.method = options.method
    this.errorCode = options.errorCode
    this.description = options.description
  }

  /** True when Telegram answered `429` and a retry after the wait may succeed. */
  get isRateLimited() {
    return this.errorCode === 429
  }
}

/**
 * Split a proxy URL into the fields the tunnel builders need.
 * @param {string} proxy - proxy URL as configured by the user.
 * @returns {{ kind: 'http' | 'socks5', host: string, port: number, auth: { username: string, password: string, socks5: boolean } | undefined }}
 */
export function parseProxyUrl(proxy) {
  let url
  try {
    url = new URL(proxy)
  } catch {
    throw new TelegramApiError(`invalid proxy URL: ${proxy}`)
  }
  const protocol = url.protocol.replace(/:$/, '').toLowerCase()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port === '' ? (protocol.startsWith('socks') ? 1080 : 8080) : Number(url.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TelegramApiError(`invalid proxy port in ${proxy}`)
  }
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const auth = username === '' && password === '' ? undefined : { username, password, socks5: protocol.startsWith('socks') }
  if (protocol === 'http' || protocol === 'https') return { kind: 'http', host, port, auth }
  if (protocol === 'socks5' || protocol === 'socks5h' || protocol === 'socks') {
    return { kind: 'socks5', host, port, auth }
  }
  throw new TelegramApiError(
    `unsupported proxy scheme "${protocol}:" (use http://, https:// or socks5://)`,
  )
}

/**
 * Open a raw tunnel socket to `host:port` through a proxy.
 * @param {{ kind: 'http' | 'socks5', host: string, port: number, auth?: object }} proxy - parsed proxy.
 * @param {string} host - destination host.
 * @param {number} port - destination port.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<import('node:net').Socket>} connected socket.
 */
function openTunnel(proxy, host, port, signal) {
  return proxy.kind === 'socks5'
    ? openSocks5Tunnel(proxy, host, port, signal)
    : openHttpConnectTunnel(proxy, host, port, signal)
}

/**
 * HTTP CONNECT tunnel for an https destination.
 * @param {{ host: string, port: number, auth?: object }} proxy - proxy endpoint.
 * @param {string} host - destination host.
 * @param {number} port - destination port.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<import('node:net').Socket>} tunnelled socket.
 */
function openHttpConnectTunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${host}:${port}` }
    if (proxy.auth !== undefined) {
      const raw = `${proxy.auth.username}:${proxy.auth.password}`
      headers['proxy-authorization'] = `Basic ${Buffer.from(raw).toString('base64')}`
    }
    const req = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      signal,
      setHost: false,
      timeout: DEFAULT_TIMEOUT_MS,
    })
    req.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new TelegramApiError(`proxy CONNECT failed with status ${response.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.once('timeout', () => req.destroy(new TelegramApiError('proxy CONNECT timed out')))
    req.once('error', (error) => reject(error))
    req.end()
  })
}

/**
 * SOCKS5 tunnel (username/password auth, IPv4/domain/IPv6 targets).
 * @param {{ host: string, port: number, auth?: object }} proxy - proxy endpoint.
 * @param {string} host - destination host.
 * @param {number} port - destination port.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<import('node:net').Socket>} tunnelled socket.
 */
function openSocks5Tunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port })
    /** @type {Buffer} */
    let pending = Buffer.alloc(0)
    let stage = 'greeting'
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error) => {
      cleanup()
      socket.destroy()
      reject(error instanceof Error ? error : new TelegramApiError(String(error)))
    }
    const onError = (error) => fail(error)
    const onClose = () => fail(new TelegramApiError('SOCKS5 proxy closed the connection'))
    const onAbort = () => fail(new TelegramApiError('SOCKS5 tunnel aborted'))
    const done = () => {
      cleanup()
      resolve(socket)
    }
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk])
      try {
        if (stage === 'greeting') {
          if (pending.length < 2) return
          const version = pending[0]
          const method = pending[1]
          pending = pending.subarray(2)
          if (version !== 5) throw new TelegramApiError('SOCKS5 proxy answered with a bad version')
          if (method === 0xff) throw new TelegramApiError('SOCKS5 proxy rejected every auth method')
          if (method === 0x02) {
            const username = Buffer.from(proxy.auth?.username ?? '', 'utf8')
            const password = Buffer.from(proxy.auth?.password ?? '', 'utf8')
            const packet = Buffer.concat([
              Buffer.from([0x01, username.length]),
              username,
              Buffer.from([password.length]),
              password,
            ])
            stage = 'auth'
            socket.write(packet)
            return
          }
          if (method !== 0x00) throw new TelegramApiError(`SOCKS5 proxy asked for unsupported method ${method}`)
          stage = 'connect'
          socket.write(buildSocks5Connect(host, port))
          return
        }
        if (stage === 'auth') {
          if (pending.length < 2) return
          const status = pending[1]
          pending = pending.subarray(2)
          if (status !== 0x00) throw new TelegramApiError('SOCKS5 proxy rejected the credentials')
          stage = 'connect'
          socket.write(buildSocks5Connect(host, port))
          return
        }
        if (stage === 'connect') {
          if (pending.length < 4) return
          const reply = pending[1]
          const addressType = pending[3]
          const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : pending[4] + 1
          if (pending.length < 4 + addressLength + 2) return
          if (reply !== 0x00) throw new TelegramApiError(`SOCKS5 connect failed with reply ${reply}`)
          pending = pending.subarray(4 + addressLength + 2)
          if (pending.length > 0) socket.unshift(pending)
          done()
        }
      } catch (error) {
        fail(error)
      }
    }
    if (signal.aborted) {
      fail(new TelegramApiError('SOCKS5 tunnel aborted'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      const methods = proxy.auth === undefined ? [0x00] : [0x00, 0x02]
      socket.write(Buffer.from([0x05, methods.length, ...methods]))
    })
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/**
 * Build the SOCKS5 CONNECT request for one destination.
 * @param {string} host - destination host (domain, IPv4 or IPv6).
 * @param {number} port - destination port.
 * @returns {Buffer} request frame.
 */
function buildSocks5Connect(host, port) {
  const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff])
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split('.').map(Number)), portBytes])
  }
  if (host.includes(':')) {
    // Minimal IPv6 expansion into eight 16-bit groups.
    const groups = expandIpv6(host)
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), groups, portBytes])
  }
  const name = Buffer.from(host, 'utf8')
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBytes])
}

/**
 * Expand an IPv6 literal into its 16 raw bytes.
 * @param {string} host - IPv6 literal.
 * @returns {Buffer} 16 bytes.
 */
function expandIpv6(host) {
  const [head, tail] = host.split('::')
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === undefined ? [] : tail === '' ? [] : tail.split(':')
  const missing = 8 - headParts.length - tailParts.length
  const parts = [...headParts, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...tailParts]
  const bytes = Buffer.alloc(16)
  parts.forEach((part, index) => {
    const value = Number.parseInt(part === '' ? '0' : part, 16)
    bytes.writeUInt16BE(Number.isFinite(value) ? value : 0, index * 2)
  })
  return bytes
}

/**
 * Create the Bot API client.
 * @param {{
 *   token: string,
 *   baseUrl?: string,
 *   proxy?: string,
 *   timeoutMs?: number,
 *   logger?: { debug?: Function, warn?: Function, error?: Function },
 *   maxRetries?: number,
 * }} options - client configuration. `baseUrl` may point at an http mock for tests.
 * @returns {{
 *   token: string,
 *   call: (method: string, payload?: object, options?: object) => Promise<any>,
 *   getMe: () => Promise<any>,
 *   getUpdates: (options?: object) => Promise<any[]>,
 *   sendMessage: (chatId: string | number, text: string, options?: object) => Promise<any>,
 *   editMessageText: (chatId: string | number, messageId: number, text: string, options?: object) => Promise<any>,
 *   answerCallbackQuery: (id: string, options?: object) => Promise<any>,
 *   sendChatAction: (chatId: string | number, action?: string) => Promise<any>,
 *   deleteMessage: (chatId: string | number, messageId: number) => Promise<any>,
 *   setMyCommands: (commands: Array<{ command: string, description: string }>) => Promise<any>,
 *   splitText: (text: string, limit?: number) => string[],
 * }}
 */
export function createTelegramApi(options) {
  const {
    token,
    baseUrl = DEFAULT_BASE_URL,
    proxy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger,
    maxRetries = 2,
  } = options ?? {}
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TelegramApiError('a bot token is required')
  }
  const endpoint = new URL(baseUrl)
  const parsedProxy = proxy === undefined || proxy === '' ? undefined : parseProxyUrl(proxy)
  const isHttps = endpoint.protocol === 'https:'

  /**
   * Perform one HTTPS/HTTP request, optionally through the configured proxy.
   * @param {string} method - HTTP method.
   * @param {string} path - request path including the bot token.
   * @param {object | undefined} payload - JSON body.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<any>} parsed response body.
   */
  async function transport(method, path, payload, signal) {
    const host = endpoint.hostname.replace(/^\[|\]$/g, '')
    const port = endpoint.port === '' ? (isHttps ? 443 : 80) : Number(endpoint.port)
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8')
    const headers = {
      host: endpoint.port === '' ? host : `${host}:${endpoint.port}`,
      accept: 'application/json',
      'user-agent': 'dsh-plugin-telegram/0.1 (+https://core.telegram.org/bots/api)',
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(body.length)
    }

    /** @type {Record<string, unknown>} */
    const requestOptions = { method, path, headers, signal, timeout: timeoutMs, host, port, setHost: false }
    if (parsedProxy !== undefined) {
      // Every proxied route is tunnelled (CONNECT or SOCKS5), so plain-HTTP and
      // HTTPS targets share one code path and credentials never leak into a
      // forwarded request line.
      const socket = await openTunnel(parsedProxy, host, port, signal)
      const tunnel = isHttps ? tlsConnect({ socket, servername: host }) : socket
      if (isHttps) {
        await once(tunnel, 'secureConnect', signal).catch((error) => {
          tunnel.destroy()
          throw error
        })
      }
      requestOptions.createConnection = () => tunnel
    }

    const requestFn = isHttps ? httpsRequest : httpRequest
    return await new Promise((resolve, reject) => {
      const req = requestFn(requestOptions, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (text === '') {
            reject(new TelegramApiError(`empty response from Bot API for ${path.split('/').pop()}`, { method }))
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(new TelegramApiError(`invalid JSON from Bot API: ${text.slice(0, 200)}`, { method, cause: error }))
          }
        })
        res.on('error', reject)
      })
      req.once('timeout', () => req.destroy(new TelegramApiError(`Bot API request timed out after ${timeoutMs}ms`, { method })))
      req.once('error', (error) => {
        if (error instanceof TelegramApiError) reject(error)
        else reject(new TelegramApiError(`${method} transport failed: ${error.message}`, { method, cause: error }))
      })
      req.end(body)
    })
  }

  /**
   * Invoke one Bot API method.
   * @param {string} method - Bot API method name.
   * @param {object} [payload] - JSON payload.
   * @param {{ signal?: AbortSignal, retry?: boolean }} [callOptions] - per-call options.
   * @returns {Promise<any>} the `result` member.
   */
  async function call(method, payload, callOptions = {}) {
    const signal = callOptions.signal ?? AbortSignal.timeout(timeoutMs)
    const retryable = callOptions.retry ?? !NON_IDEMPOTENT.has(method)
    let attempt = 0
    for (;;) {
      let response
      try {
        response = await transport('POST', `/bot${token}/${method}`, payload, signal)
      } catch (error) {
        if (attempt >= maxRetries || !retryable || signal.aborted) throw error
        attempt += 1
        logger?.debug?.(`telegram: ${method} attempt ${attempt} failed: ${error.message}`)
        await delay(Math.min(5000, 500 * 2 ** attempt), signal)
        continue
      }
      if (response?.ok !== true) {
        const errorCode = Number(response?.error_code ?? 0) || undefined
        const description = String(response?.description ?? 'unknown Bot API error')
        const retryAfter = Number(response?.parameters?.retry_after ?? 0)
        const error = new TelegramApiError(`Telegram ${method} failed: ${description}`, { method, errorCode, description })
        if (errorCode === 429 && retryAfter > 0 && attempt < maxRetries) {
          attempt += 1
          logger?.warn?.(`telegram: rate limited on ${method}, retrying in ${retryAfter}s`)
          await delay(Math.min(retryAfter * 1000, 30_000), signal)
          continue
        }
        throw error
      }
      return response.result
    }
  }

  return {
    token,
    call,
    getMe: () => call('getMe', {}),
    getUpdates: (updateOptions = {}) =>
      call('getUpdates', updateOptions, { signal: updateOptions.signal, retry: true }),
    sendMessage: (chatId, text, messageOptions = {}) =>
      call('sendMessage', { chat_id: chatId, text, ...messageOptions }, { retry: false }),
    editMessageText: (chatId, messageId, text, messageOptions = {}) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...messageOptions }, { retry: false }),
    answerCallbackQuery: (callbackQueryId, callbackOptions = {}) =>
      call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...callbackOptions }, { retry: false }),
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }),
    deleteMessage: (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
    setMyCommands: (commands) => call('setMyCommands', { commands }),
    splitText,
  }
}

/**
 * Wait for one emitter event, honouring cancellation.
 * @param {import('node:events').EventEmitter} emitter - stream or socket.
 * @param {string} event - event name.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolves when the event fires.
 */
function once(emitter, event, signal) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      reject(new TelegramApiError('tunnel aborted'))
    }
    const cleanup = () => {
      emitter.off(event, onEvent)
      emitter.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    emitter.once(event, onEvent)
    emitter.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Sleep that respects cancellation.
 * @param {number} ms - delay.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TelegramApiError('request aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new TelegramApiError('request aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Split text into Bot API sized chunks, preferring paragraph boundaries.
 * @param {string} text - full text.
 * @param {number} [limit] - maximum chunk length.
 * @returns {string[]} chunks that each fit the limit.
 */
export function splitText(text, limit = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const value = String(text ?? '')
  if (value.length <= limit) return [value]
  const chunks = []
  let rest = value
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf(' ', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** Random 32-bit integer used as an update id seed by tests and helpers. */
export function randomUpdateSeed() {
  return randomBytes(4).readUInt32BE(0)
}
