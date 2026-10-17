// Local mock of the Telegram Bot API for tests.
//
// The host machine cannot reach api.telegram.org, so every test drives the
// plugin's HTTP client against this server on 127.0.0.1 (port 0 = ephemeral).
//
// Protocol shape implemented (a subset of the real Bot API):
//   POST|GET /bot<token>/<method> -> { ok: true, result: ... }
//   failures                   -> { ok: false, error_code, description }
//
// Supported methods:
//   getMe, getUpdates (long polling with offset/timeout), sendMessage,
//   editMessageText, answerCallbackQuery, sendChatAction, deleteMessage,
//   setMyCommands, getWebhookInfo, deleteWebhook
//
// Zero dependencies, ESM, node:http only.

import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_QUEUE = 1000;

/** Sequential id generator for updates/messages (Telegram uses int32). */
function nextId(counter) {
  counter.value += 1;
  return counter.value;
}

function toBool(value) {
  if (value === undefined || value === null || value === '') return false;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function toInt(value, fallback = 0) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  const text = raw.toString('utf8');
  if (contentType && contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  // application/x-www-form-urlencoded
  const out = {};
  for (const [key, value] of new URLSearchParams(text)) out[key] = value;
  return out;
}

/**
 * Decode JSON-encoded form fields, which is how the Bot API accepts
 * reply_markup and other nested values over urlencoded form posts.
 */
function maybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Start a mock Telegram Bot API server.
 *
 * @param {{ token?: string, botInfo?: object, drainMs?: number }} [options]
 * @returns {Promise<{
 *   baseUrl: string, port: number, token: string,
 *   pushUpdate: (update: object) => object,
 *   pushText: (input: { chatId: number|string, userId?: number, text: string, username?: string, messageId?: number }) => object,
 *   pushCallback: (input: { chatId: number|string, userId?: number, data: string, username?: string }) => object,
 *   calls: Array<{ method: string, body: object, at: number }>,
 *   lastCall: (method?: string) => object | undefined,
 *   callsOf: (method: string) => Array<object>,
 *   waitFor: (predicate: (call: object, calls: Array<object>) => boolean, timeoutMs?: number) => Promise<object>,
 *   waitForText: (substring: string, timeoutMs?: number) => Promise<object>,
 *   setBotInfo: (patch: object) => void,
 *   reset: () => void,
 *   close: () => Promise<void>,
 * }} handle
 */
export async function startMockBotApi(options = {}) {
  const token = options.token ?? '123456:TEST-TOKEN';
  const botInfo = {
    id: 424242,
    is_bot: true,
    first_name: 'DSH Test Bot',
    username: 'dsh_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    ...options.botInfo,
  };

  /** @type {Array<{ method: string, body: object, at: number }>} */
  const calls = [];
  /** @type {Array<object>} */
  const pending = []; // updates not yet delivered to getUpdates
  let updateCounter = 0;
  let messageCounter = 0;
  let confirmedOffset = 0; // highest update_id already acknowledged by the client
  let closed = false;

  /** Long-poll waiters: resolved when a new update is pushed. */
  const waiters = new Set();

  function wakeWaiters() {
    for (const resolve of [...waiters]) {
      waiters.delete(resolve);
      resolve();
    }
  }

  /** Resolve when an update arrives or the timeout elapses, whichever first. */
  function waitForUpdateOrTimeout(timeoutMs) {
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      // unref so a dangling long poll never keeps the test runner alive
      if (typeof timer.unref === 'function') timer.unref();
      waiters.add(done);
    });
  }

  function recordCall(method, body) {
    const call = { method, body, at: Date.now() };
    calls.push(call);
    return call;
  }

  function makeMessage({ chatId, userId, text, username, messageId }) {
    const id = messageId ?? ++messageCounter;
    const from = {
      id: userId ?? 111,
      is_bot: false,
      first_name: username ?? 'Tester',
      username: username ?? 'tester',
    };
    return {
      message_id: id,
      from,
      chat: { id: chatId, type: 'private', first_name: from.first_name, username: from.username },
      date: Math.floor(Date.now() / 1000),
      text,
    };
  }

  /** Push a fully-formed update object into the queue. */
  function pushUpdate(update) {
    const withId = {
      update_id: update.update_id ?? ++updateCounter,
      ...update,
    };
    if (withId.update_id > updateCounter) updateCounter = withId.update_id;
    if (pending.length >= MAX_QUEUE) pending.shift();
    pending.push(withId);
    wakeWaiters();
    return withId;
  }

  function pushText({ chatId, userId, text, username, messageId }) {
    const message = makeMessage({ chatId, userId, text, username, messageId });
    return pushUpdate({ message });
  }

  function pushCallback({ chatId, userId, data, username, messageId }) {
    const message = makeMessage({
      chatId,
      userId,
      text: 'callback message',
      username,
      messageId,
    });
    return pushUpdate({
      callback_query: {
        id: `cb-${++updateCounter}`,
        from: message.from,
        chat_instance: 'test-chat-instance',
        data,
        message,
      },
    });
  }

  function getUpdates(body) {
    const offset = body.offset === undefined ? undefined : toInt(body.offset, 0);
    const limit = Math.min(Math.max(toInt(body.limit, 100), 1), 100);
    // timeout in seconds; the mock caps it so a hung test still finishes
    const timeoutMs = Math.min(Math.max(toInt(body.timeout, 0), 0), 30) * 1000;

    if (offset !== undefined && Number.isFinite(offset)) {
      // Acknowledge everything below the offset.
      while (pending.length && pending[0].update_id < offset) pending.shift();
      confirmedOffset = Math.max(confirmedOffset, offset);
    }

    const take = () => {
      const selected = pending.slice(0, limit);
      pending.splice(0, selected.length);
      if (selected.length) confirmedOffset = Math.max(confirmedOffset, selected.at(-1).update_id + 1);
      return selected;
    };

    if (pending.length) return Promise.resolve(take());
    if (timeoutMs === 0) return Promise.resolve([]);

    // Long poll: return as soon as an update is pushed, else after timeout.
    return waitForUpdateOrTimeout(timeoutMs).then(() => take());
  }

  const handlers = {
    async getMe() {
      return botInfo;
    },
    async getWebhookInfo() {
      return { url: '', has_custom_certificate: false, pending_update_count: pending.length };
    },
    async deleteWebhook() {
      return true;
    },
    async getUpdates(body) {
      return getUpdates(body);
    },
    async sendMessage(body) {
      const messageId = ++messageCounter;
      // Telegram itself rejects empty text; mirror that so tests catch blank renders.
      const text = body.text ?? '';
      if (!text) {
        const err = new Error('Bad Request: message text is empty');
        err.errorCode = 400;
        throw err;
      }
      return {
        message_id: messageId,
        from: botInfo,
        chat: { id: toInt(body.chat_id), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
        ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}),
      };
    },
    async editMessageText(body) {
      if (!body.text) {
        const err = new Error('Bad Request: message text is empty');
        err.errorCode = 400;
        throw err;
      }
      return {
        message_id: toInt(body.message_id, 1),
        from: botInfo,
        chat: { id: toInt(body.chat_id), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: body.text,
        edit_date: Math.floor(Date.now() / 1000),
      };
    },
    async answerCallbackQuery() {
      return true;
    },
    async sendChatAction() {
      return true;
    },
    async deleteMessage() {
      return true;
    },
    async setMyCommands() {
      return true;
    },
    async getChat() {
      return { id: 0, type: 'private' };
    },
  };

  let inFlight = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    inFlight += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight -= 1;
    };
    res.once('close', settle);
    res.once('finish', settle);
    req.once('error', settle);
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      const send = (status, payload) => {
        if (res.writableEnded || res.destroyed) return;
        const bodyText = JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyText),
        });
        res.end(bodyText);
      };

      // A client that aborts a long poll destroys the socket; that must not
      // surface as an unhandled error in the mock.
      res.on('error', () => {});

      // Route: /bot<token>/<method> (also tolerate a leading "/bot" only form)
      const botSegment = parts[0] ?? '';
      if (!botSegment.startsWith('bot')) {
        send(404, { ok: false, error_code: 404, description: 'Not Found' });
        return;
      }
      const urlToken = botSegment.slice(3);
      const method = parts[1] ?? '';

      if (urlToken !== token) {
        send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }

      const handler = handlers[method];
      if (!handler) {
        send(404, {
          ok: false,
          error_code: 404,
          description: `Not Found: method ${method} not implemented by mock`,
        });
        return;
      }

      let body = parseBody(raw, req.headers['content-type']);
      // GET requests carry params in the query string; merge them in.
      for (const [key, value] of url.searchParams) if (!(key in body)) body[key] = value;
      if (raw.length) body = { ...body };
      for (const key of ['reply_markup', 'reply_parameters', 'link_preview_options']) {
        if (typeof body[key] === 'string') body[key] = maybeJson(body[key]);
      }

      const call = recordCall(method, body);

      try {
        const result = await handler(body);
        send(200, { ok: true, result });
      } catch (error) {
        const code = error.errorCode ?? 400;
        call.error = { code, description: error.message };
        send(code, {
          ok: false,
          error_code: code,
          description: error.message,
        });
      }
    });
  });

  server.keepAliveTimeout = 1000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  function callsOf(method) {
    return calls.filter((call) => call.method === method);
  }

  function lastCall(method) {
    if (!method) return calls.at(-1);
    return callsOf(method).at(-1);
  }

  async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = calls.find((call) => {
        try {
          return predicate(call, calls);
        } catch {
          return false;
        }
      });
      if (found) return found;
      if (Date.now() >= deadline) {
        const seen = calls.map((c) => c.method).join(', ') || '<none>';
        throw new Error(`mock-bot-api: waitFor timed out after ${timeoutMs}ms (calls: ${seen})`);
      }
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }

  function waitForText(substring, timeoutMs = 5000) {
    return waitFor(
      (call) =>
        (call.method === 'sendMessage' || call.method === 'editMessageText') &&
        typeof call.body?.text === 'string' &&
        call.body.text.includes(substring),
      timeoutMs,
    );
  }

  async function close() {
    if (closed) return;
    closed = true;
    wakeWaiters();
    // A pending long poll keeps its socket alive: stop accepting, give active
    // requests a moment to drain, then force-close whatever is left so the
    // test runner can exit.
    const closedPromise = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    const force = setTimeout(() => server.closeAllConnections?.(), 200);
    force.unref?.();
    await closedPromise;
    clearTimeout(force);
    server.closeAllConnections?.();
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    token,
    botInfo,
    calls,
    pushUpdate,
    pushText,
    pushCallback,
    callsOf,
    lastCall,
    waitFor,
    waitForText,
    setBotInfo(patch) {
      Object.assign(botInfo, patch);
    },
    reset() {
      calls.length = 0;
      pending.length = 0;
      confirmedOffset = 0;
    },
    close,
  };
}

export default startMockBotApi;
