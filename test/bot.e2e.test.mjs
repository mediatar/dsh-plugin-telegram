// End-to-end tests for the Telegram bot router.
//
// The bot is exercised through the REAL Bot API client (`createTelegramApi`)
// against the local mock server: every assertion on outbound traffic is made
// from `mock.calls`, exactly as Telegram would have received it. Only
// `bridge` is fake — it implements the session-bridge contract from
// plugin/SPEC.md.
//
// No network, no fixed ports, no npm dependencies.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startMockBotApi } from './mock-bot-api.js';
// eslint-disable-next-line import-x/no-unresolved -- plain relative ESM file
import { createBot, createPoller, renderHelp, renderStatus } from '../lib/bot.js';
import { createTelegramApi } from '../lib/telegram-api.js';

const TOKEN = '111222:MOCK-E2E-TOKEN';
const CHAT_ID = 4242;
const GOOD_USER = 1001;
const OTHER_USER = 1002;
const STRANGER = 9999;

/**
 * In-memory implementation of the `session-bridge.js` contract.
 * Records every call so tests can assert on delegation.
 */
function createFakeBridge(overrides = {}) {
  /** @type {Array<{ method: string, args: any[] }>} */
  const calls = [];
  const record = (method, ...args) => {
    calls.push({ method, args });
  };

  const projects = [
    { id: 'wp-alpha', title: 'Alpha', path: 'C:\\work\\alpha', sessionCount: 2 },
    { id: 'wp-beta', title: 'Beta', path: 'C:\\work\\beta', sessionCount: 1 },
  ];

  const sessionsByProject = {
    'wp-alpha': [
      {
        sessionId: 'sess-alpha-one-long-id',
        title: 'Refactor the poller',
        cwd: 'C:\\work\\alpha',
        running: true,
        updatedAt: Date.now() - 5 * 60_000,
      },
      {
        sessionId: 'sess-alpha-two-long-id',
        title: 'Write docs',
        cwd: 'C:\\work\\alpha',
        running: false,
        updatedAt: Date.now() - 3 * 60 * 60_000,
      },
    ],
    'wp-beta': [
      {
        sessionId: 'sess-beta-one-long-id',
        title: 'Spike proxy support',
        cwd: 'C:\\work\\beta',
        running: false,
        updatedAt: Date.now() - 24 * 60 * 60_000,
      },
    ],
  };

  /** @type {Array<(event: object) => void>} */
  const watchers = [];
  /** Unsubscribe call counts per session id, to prove watchers are released. */
  const unsubscribeCalls = new Map();
  let currentProjectId = null;
  let currentSessionId = null;
  let createdSessions = 0;

  const findProject = (ref) =>
    projects.find(
      (project) =>
        project.id === ref ||
        project.title === ref ||
        project.path === ref ||
        project.path.toLowerCase() === String(ref).toLowerCase(),
    );

  const findSession = (ref) => {
    const all = Object.values(sessionsByProject).flat();
    const text = String(ref);
    return (
      all.find((session) => session.sessionId === text) ??
      all.find((session) => session.sessionId.startsWith(text)) ??
      // 1-based index across the current project's list
      (() => {
        const list = sessionsByProject[currentProjectId] ?? [];
        const index = Number(text);
        return Number.isInteger(index) && index >= 1 ? list[index - 1] : undefined;
      })()
    );
  };

  const bridge = {
    calls,
    /** Fire a watcher handler for `sessionId`; returns how many watchers matched. */
    emit(sessionId, handler, ...args) {
      let matched = 0;
      for (const watcher of watchers) {
        if (watcher.sessionId === sessionId) {
          watcher.handlers[handler]?.(...args);
          matched += 1;
        }
      }
      return matched;
    },
    watcherCount() {
      return watchers.length;
    },
    unsubscribeCount(sessionId) {
      return unsubscribeCalls.get(sessionId) ?? 0;
    },
    listProjects: async () => {
      record('listProjects');
      return projects.map((project) => ({ ...project }));
    },
    resolveProject: async (ref) => {
      record('resolveProject', ref);
      const found = findProject(ref);
      return found === undefined ? undefined : { ...found };
    },
    createProject: async (path) => {
      record('createProject', path);
      const created = {
        id: `wp-created-${projects.length}`,
        title: String(path).split('\\').pop() ?? 'created',
        path,
        sessionCount: 0,
      };
      projects.push(created);
      sessionsByProject[created.id] = [];
      return { ...created };
    },
    listSessions: async (options = {}) => {
      record('listSessions', options);
      const projectId = options.projectId ?? currentProjectId ?? 'wp-alpha';
      const list = sessionsByProject[projectId] ?? [];
      const limited = typeof options.limit === 'number' ? list.slice(0, options.limit) : list;
      return limited.map((session) => ({ ...session }));
    },
    resolveSession: async (ref) => {
      record('resolveSession', ref);
      const found = findSession(ref);
      return found === undefined ? undefined : { sessionId: found.sessionId };
    },
    createSession: async (options = {}) => {
      record('createSession', options);
      createdSessions += 1;
      const sessionId = `sess-new-${createdSessions}-long-id`;
      const cwd = projects.find((p) => p.id === options.projectId)?.path ?? 'C:\\work\\unknown';
      const created = {
        sessionId,
        title: 'Untitled',
        cwd,
        running: false,
        updatedAt: Date.now(),
      };
      const bucket = (sessionsByProject[options.projectId ?? currentProjectId] ??= []);
      bucket.unshift(created);
      return { sessionId, cwd };
    },
    sendPrompt: async (sessionId, text) => {
      record('sendPrompt', sessionId, text);
      return { ok: true };
    },
    cancel: async (sessionId) => {
      record('cancel', sessionId);
    },
    renameSession: async (sessionId, title) => {
      record('renameSession', sessionId, title);
    },
    watchSession: (sessionId, handlers) => {
      record('watchSession', sessionId);
      const entry = { sessionId, handlers };
      watchers.push(entry);
      return () => {
        unsubscribeCalls.set(sessionId, (unsubscribeCalls.get(sessionId) ?? 0) + 1);
        const index = watchers.indexOf(entry);
        if (index !== -1) watchers.splice(index, 1);
      };
    },
    currentProject: () => {
      const found = projects.find((project) => project.id === currentProjectId);
      return found === undefined ? null : { ...found };
    },
    setCurrentProject: (id) => {
      record('setCurrentProject', id);
      currentProjectId = id;
    },
    currentSession: () => {
      if (currentSessionId === null) return null;
      const found = Object.values(sessionsByProject).flat().find((s) => s.sessionId === currentSessionId);
      return found === undefined ? { sessionId: currentSessionId } : { ...found };
    },
    setCurrentSession: (sessionId) => {
      record('setCurrentSession', sessionId);
      currentSessionId = sessionId;
    },
    info: () => ({ hostname: 'test-host', dshVersion: '0.2.1-rc.2', cwd: 'C:\\work\\alpha' }),
    /** Test helpers (not part of the contract). */
    getCurrentProjectId: () => currentProjectId,
    getCurrentSessionId: () => currentSessionId,
    setProjects: (next) => {
      projects.length = 0;
      projects.push(...next);
    },
    ...overrides,
  };

  return bridge;
}

/** Wait until `predicate()` is truthy, polling the mock's recorded traffic. */
async function until(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Find the last sendMessage/editMessageText whose text satisfies the predicate. */
function lastTextMatching(mock, predicate) {
  for (let index = mock.calls.length - 1; index >= 0; index -= 1) {
    const call = mock.calls[index];
    if (call.method !== 'sendMessage' && call.method !== 'editMessageText') continue;
    if (typeof call.body?.text !== 'string') continue;
    if (predicate(call.body.text, call)) return call;
  }
  return undefined;
}

function textOf(call) {
  return call?.body?.text ?? '';
}

/** All callback_data values present in a sendMessage's inline keyboard. */
function callbackData(call) {
  const keyboard = call?.body?.reply_markup?.inline_keyboard ?? [];
  return keyboard.flat().map((button) => button.callback_data);
}

/** Send one update through the bot and wait for it to settle. */
async function deliver(mock, bot, update) {
  await bot.handleUpdate(update);
}

describe('telegram bot e2e', () => {
  /** @type {Awaited<ReturnType<typeof startMockBotApi>>} */
  let mock;
  /** @type {ReturnType<typeof createTelegramApi>} */
  let api;
  /** @type {ReturnType<typeof createFakeBridge>} */
  let bridge;
  /** @type {ReturnType<typeof createBot>} */
  let bot;

  const logs = [];
  const logger = {
    debug: (message) => logs.push(['debug', message]),
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  };

  before(async () => {
    mock = await startMockBotApi({ token: TOKEN });
    api = createTelegramApi({ token: TOKEN, baseUrl: mock.baseUrl, timeoutMs: 5000, logger });
  });

  after(async () => {
    bot?.stop();
    await mock.close();
  });

  beforeEach(() => {
    mock.reset();
    logs.length = 0;
    bridge = createFakeBridge();
    bot = createBot({
      api,
      bridge,
      config: { allowedUsers: [GOOD_USER, OTHER_USER], stream: true, notifyTools: false, markdown: false },
      logger,
    });
  });

  /** Push a text update and let the bot process it. */
  async function say(text, { userId = GOOD_USER, chatId = CHAT_ID } = {}) {
    const update = mock.pushText({ chatId, userId, text });
    await deliver(mock, bot, update);
    return update;
  }

  /** Push a callback update and let the bot process it. */
  async function tap(data, { userId = GOOD_USER, chatId = CHAT_ID } = {}) {
    const update = mock.pushCallback({ chatId, userId, data });
    await deliver(mock, bot, update);
    return update;
  }

  it('reuses the mock token path and reaches the Bot API over plain HTTP', async () => {
    const me = await api.getMe();
    assert.equal(me.is_bot, true);
    assert.equal(me.username, 'dsh_test_bot');
    const call = mock.lastCall('getMe');
    assert.equal(call.method, 'getMe');
    // The mock is bound to an ephemeral port on loopback, never 443.
    assert.match(mock.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('/start renders the help panel', async () => {
    await say('/start');
    const call = mock.waitForText('DeepSeek Harness → Telegram', 2000);
    const sent = await call;
    assert.equal(sent.method, 'sendMessage');
    assert.equal(String(sent.body.chat_id), String(CHAT_ID));
    // The help text lists the core commands.
    for (const command of ['/projects', '/sessions', '/new', '/use', '/status', '/cancel', '/rename']) {
      assert.ok(textOf(sent).includes(command), `help should mention ${command}`);
    }
    // /start must not talk to the bridge for listing.
    assert.equal(bridge.calls.some((c) => c.method === 'listProjects'), false);
  });

  it('/help behaves like /start', async () => {
    await say('/help');
    const sent = await mock.waitForText('DeepSeek Harness → Telegram', 2000);
    assert.match(textOf(sent), /Anything else you send is delivered as a prompt/);
  });

  it('/projects lists projects with an inline keyboard', async () => {
    await say('/projects');
    const sent = await mock.waitForText('Alpha', 2000);

    const text = textOf(sent);
    assert.ok(text.includes('Beta'), 'both projects should be listed');
    assert.ok(text.includes('C:\\work\\alpha'), 'project path should be rendered');
    assert.ok(text.includes('2 sessions'), 'session count should be rendered');

    const keyboard = sent.body.reply_markup?.inline_keyboard;
    assert.ok(Array.isArray(keyboard) && keyboard.length >= 3, 'expected one row per project plus controls');
    assert.ok(callbackData(sent).includes('p:wp-alpha'));
    assert.ok(callbackData(sent).includes('p:wp-beta'));
    // Control row required by the task.
    assert.ok(callbackData(sent).includes('p:refresh'));
    assert.ok(callbackData(sent).includes('new'));

    const listCall = bridge.calls.find((c) => c.method === 'listProjects');
    assert.ok(listCall, 'bridge.listProjects must be used');
  });

  it('selecting a project via callback switches it and shows sessions', async () => {
    await say('/projects');
    await mock.waitForText('Alpha', 2000);
    mock.reset();

    await tap('p:wp-beta');

    // 1. the callback itself is acknowledged
    const ack = await mock.waitFor((call) => call.method === 'answerCallbackQuery', 2000);
    assert.equal(ack.body.callback_query_id.startsWith('cb-'), true);

    // 2. the project is made current ...
    await until(() => bridge.getCurrentProjectId() === 'wp-beta', 'project switch');
    assert.ok(bridge.calls.some((c) => c.method === 'setCurrentProject' && c.args[0] === 'wp-beta'));

    // 3. ... and the session list follows automatically
    const sessionsCall = await mock.waitForText('Spike proxy support', 2000);
    assert.ok(textOf(sessionsCall).includes('Sessions'));
    assert.ok(callbackData(sessionsCall).includes('s:1'));
  });

  it('the p:refresh callback reloads the project list', async () => {
    await tap('p:refresh');
    const sent = await mock.waitForText('Alpha', 2000);
    assert.ok(callbackData(sent).includes('p:wp-alpha'));
    assert.equal((await mock.waitFor((call) => call.method === 'answerCallbackQuery', 2000)).method, 'answerCallbackQuery');
  });

  it('/sessions lists the current project sessions with s:<n> buttons', async () => {
    bridge.setCurrentProject('wp-alpha');
    await say('/sessions');

    const sent = await mock.waitForText('Refactor the poller', 2000);
    const text = textOf(sent);
    assert.ok(text.includes('Write docs'), 'all sessions in the project should be listed');
    assert.ok(text.includes('⏳'), 'a running session should be marked');

    const data = callbackData(sent);
    assert.deepEqual(data.slice(0, 2), ['s:1', 's:2']);

    const listCall = bridge.calls.find((c) => c.method === 'listSessions');
    assert.equal(listCall.args[0].projectId, 'wp-alpha');
  });

  it('/sessions with no sessions suggests /new', async () => {
    bridge.setProjects([{ id: 'wp-empty', title: 'Empty', path: 'C:\\work\\empty', sessionCount: 0 }]);
    bridge.setCurrentProject('wp-empty');
    await say('/sessions');
    const sent = await mock.waitForText('No sessions', 2000);
    assert.ok(textOf(sent).includes('/new'));
  });

  it('selecting a session via callback switches and confirms', async () => {
    bridge.setCurrentProject('wp-alpha');
    await say('/sessions');
    await mock.waitForText('Refactor the poller', 2000);
    mock.reset();

    await tap('s:2');

    const sent = await mock.waitForText('Now sending to', 2000);
    assert.ok(textOf(sent).includes('Write docs'), 'the second session should be selected');
    assert.equal(bridge.getCurrentSessionId(), 'sess-alpha-two-long-id');
    // Selecting must arm the stream watcher for that session.
    assert.ok(bridge.calls.some((c) => c.method === 'watchSession' && c.args[0] === 'sess-alpha-two-long-id'));
    assert.ok(callbackData(sent).includes('status'), 'confirmation should offer a status button');
    assert.ok(callbackData(sent).includes('cancel'), 'confirmation should offer a stop button');
  });

  it('/use <n> switches to the listed session by number', async () => {
    bridge.setCurrentProject('wp-alpha');
    await say('/sessions');
    await mock.waitForText('Refactor the poller', 2000);

    await say('/use 2');
    const sent = await mock.waitForText('Now sending to', 2000);
    assert.ok(textOf(sent).includes('Write docs'));
    assert.equal(bridge.getCurrentSessionId(), 'sess-alpha-two-long-id');
  });

  it('/use <id> switches by id and /use <bogus> reports not found', async () => {
    await say('/use sess-beta-one-long-id');
    const ok = await mock.waitForText('Now sending to', 2000);
    // resolveSession only promises { sessionId }, so the confirmation always
    // carries the id even when the bridge cannot name the session.
    assert.ok(textOf(ok).includes('sess-beta-one-long-id'));
    assert.equal(bridge.getCurrentSessionId(), 'sess-beta-one-long-id');

    mock.reset();
    await say('/use does-not-exist');
    const missing = await mock.waitForText('was not found', 2000);
    assert.ok(textOf(missing).includes('does-not-exist'));
  });

  it('/new creates a session in the current project', async () => {
    bridge.setCurrentProject('wp-alpha');
    await say('/new');

    const sent = await mock.waitForText('New session in', 2000);
    assert.ok(textOf(sent).includes('Alpha'));
    const createCall = bridge.calls.find((c) => c.method === 'createSession');
    assert.equal(createCall.args[0].projectId, 'wp-alpha');
    assert.match(bridge.getCurrentSessionId(), /^sess-new-/);
    assert.ok(bridge.calls.some((c) => c.method === 'watchSession'));
  });

  it('/new without a project asks for one first', async () => {
    await say('/new');
    const sent = await mock.waitForText('Choose a project first', 2000);
    assert.ok(textOf(sent).includes('/projects'));
    assert.equal(bridge.calls.some((c) => c.method === 'createSession'), false);
  });

  it('plain text is delivered as a prompt to the current session', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    bridge.calls.length = 0;
    mock.reset();

    await say('please summarise the failing tests');

    const prompt = bridge.calls.find((c) => c.method === 'sendPrompt');
    assert.ok(prompt, 'bridge.sendPrompt must be called');
    assert.deepEqual(prompt.args, ['sess-alpha-one-long-id', 'please summarise the failing tests']);

    // The bot does not echo the prompt as a message; at most a typing action.
    const echoes = mock.calls.filter(
      (call) => call.method === 'sendMessage' && textOf(call).includes('please summarise the failing tests'),
    );
    assert.equal(echoes.length, 0, 'plain prompts must not be echoed back into the chat');
    await mock.waitFor((call) => call.method === 'sendChatAction', 2000);
  });

  it('plain text with no session selected explains what to do', async () => {
    await say('hello there');
    const sent = await mock.waitForText('No session selected', 2000);
    assert.ok(textOf(sent).includes('/projects'));
    assert.equal(bridge.calls.some((c) => c.method === 'sendPrompt'), false);
  });

  it('a failed prompt is reported with the bridge error', async () => {
    const failing = createFakeBridge({
      currentProject: () => ({ id: 'wp-alpha', title: 'Alpha', path: 'C:\\work\\alpha' }),
      currentSession: () => ({ sessionId: 'sess-alpha-one-long-id', title: 'Refactor the poller' }),
      sendPrompt: async () => ({ ok: false, error: 'agent is not ready' }),
      watchSession: () => () => {},
    });
    const failingBot = createBot({ api, bridge: failing, config: { allowedUsers: [] }, logger });
    try {
      await failingBot.handleUpdate(mock.pushText({ chatId: CHAT_ID, userId: GOOD_USER, text: 'go' }));
      const sent = await mock.waitForText('Not delivered', 2000);
      assert.ok(textOf(sent).includes('agent is not ready'));
    } finally {
      failingBot.stop();
    }
  });

  it('/status renders the current project and session', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('/status');

    const sent = await mock.waitForText('Status', 2000);
    const text = textOf(sent);
    assert.ok(text.includes('Alpha'), 'project title should be shown');
    assert.ok(text.includes('C:\\work\\alpha'), 'project path should be shown');
    assert.ok(text.includes('Refactor the poller'), 'session title should be shown');
    assert.ok(text.includes('sess-alpha-one-long-id'), 'full session id should be shown');
    assert.ok(text.includes('running'), 'running state should be shown');
    assert.ok(text.includes('test-host'), 'host name should be shown');

    const data = callbackData(sent);
    for (const expected of ['p:refresh', 'sessions', 'cancel']) {
      assert.ok(data.includes(expected), `status keyboard should include ${expected}`);
    }
  });

  it('/status with nothing selected stays informative', async () => {
    await say('/status');
    const sent = await mock.waitForText('Status', 2000);
    assert.ok(textOf(sent).includes('not selected'));
  });

  it('/cancel stops the running turn', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    bridge.calls.length = 0;

    await say('/cancel');
    const sent = await mock.waitForText('Cancellation requested', 2000);
    assert.ok(textOf(sent).includes('🛑'));
    const cancel = bridge.calls.find((c) => c.method === 'cancel');
    assert.deepEqual(cancel.args, ['sess-alpha-one-long-id']);
  });

  it('the cancel button in the keyboard also stops the turn', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    bridge.calls.length = 0;

    await tap('cancel');
    await mock.waitForText('Cancellation requested', 2000);
    assert.ok(bridge.calls.some((c) => c.method === 'cancel'));
  });

  it('/rename renames the current session', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    bridge.calls.length = 0;

    await say('/rename A better title');
    await mock.waitForText('Renamed to', 2000);
    const rename = bridge.calls.find((c) => c.method === 'renameSession');
    assert.deepEqual(rename.args, ['sess-alpha-one-long-id', 'A better title']);
  });

  it('streams assistant output into the chat', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('tell me a joke');
    await until(() => bridge.watcherCount() > 0, 'watcher registration');

    bridge.emit('sess-alpha-one-long-id', 'onAssistant', 'Here is a joke about proxies.');
    const streamed = await mock.waitForText('Here is a joke about proxies.', 2000);
    assert.equal(streamed.method, 'sendMessage');
    assert.equal(String(streamed.body.chat_id), String(CHAT_ID));

    // Turn end forces a final flush and detaches the watcher.
    bridge.emit('sess-alpha-one-long-id', 'onTurnEnd', 'completed');
    await until(() => bridge.watcherCount() === 0, 'watcher teardown after turn end');
  });

  it('reports a non-completed turn end reason', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('do something long');
    await until(() => bridge.watcherCount() > 0, 'watcher registration');

    bridge.emit('sess-alpha-one-long-id', 'onTurnEnd', 'user_cancelled');
    const sent = await mock.waitForText('Turn ended', 2000);
    assert.ok(textOf(sent).includes('user_cancelled'));
  });

  it('releases the bridge subscription exactly once when a turn ends', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('one turn please');
    await until(() => bridge.watcherCount() > 0, 'watcher registration');
    assert.equal(bridge.unsubscribeCount('sess-alpha-one-long-id'), 0, 'no release before turn end');

    bridge.emit('sess-alpha-one-long-id', 'onAssistant', 'partial output');
    bridge.emit('sess-alpha-one-long-id', 'onTurnEnd', 'completed');
    await until(() => bridge.watcherCount() === 0, 'watcher map cleared');
    await until(() => bridge.unsubscribeCount('sess-alpha-one-long-id') === 1, 'bridge unsubscribe called');

    // A second turn-end on the same (now detached) session must not double-release.
    bridge.emit('sess-alpha-one-long-id', 'onTurnEnd', 'completed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      bridge.unsubscribeCount('sess-alpha-one-long-id'),
      1,
      'unsubscribe must be idempotent across duplicate turn-end events',
    );
  });

  it('releases the bridge subscription on an agent error', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('break please');
    await until(() => bridge.watcherCount() > 0, 'watcher registration');

    bridge.emit('sess-alpha-one-long-id', 'onError', 'model exploded');
    await mock.waitForText('Agent error', 2000);
    await until(() => bridge.unsubscribeCount('sess-alpha-one-long-id') === 1, 'bridge unsubscribe called');
    assert.equal(bridge.watcherCount(), 0);
  });

  it('/follow toggles automatic following on and off', async () => {
    await say('/follow');
    const on = await mock.waitForText('Following the session that is active', 2000);
    assert.ok(textOf(on).includes('/follow off'), 'the on-reply should explain how to disable');

    await say('/follow off');
    const off = await mock.waitForText('Automatic following disabled', 2000);
    assert.ok(textOf(off).includes('/sessions'));

    // A disabled chat must not start mirroring when DSH changes the active session.
    bridge.calls.length = 0;
    bot.followActiveSession('sess-beta-one-long-id');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bridge.watcherCount(), 0, 'a chat that disabled following must not watch');
  });

  it('followActiveSession mirrors the DSH-active session for following chats', async () => {
    await say('/follow');
    await mock.waitForText('Following the session that is active', 2000);
    mock.reset();

    bot.followActiveSession('sess-beta-one-long-id');
    await until(() => bridge.watcherCount() === 1, 'follow watcher registration');
    assert.equal(bridge.getCurrentSessionId(), 'sess-beta-one-long-id', 'following makes the session current');

    bridge.emit('sess-beta-one-long-id', 'onAssistant', 'Live output from the DSH-active session.');
    const streamed = await mock.waitForText('Live output from the DSH-active session.', 3000);
    assert.equal(streamed.method, 'sendMessage');
    assert.equal(String(streamed.body.chat_id), String(CHAT_ID));
  });

  it('following a second active session replaces the first without leaking it', async () => {
    await say('/follow');
    await mock.waitForText('Following the session that is active', 2000);

    bot.followActiveSession('sess-alpha-one-long-id');
    await until(() => bridge.watcherCount() === 1, 'first follow watcher');
    bot.followActiveSession('sess-beta-one-long-id');
    await until(() => bridge.watcherCount() === 1, 'watcher replaced, not accumulated');

    // The superseded session's subscription must have been released.
    await until(() => bridge.unsubscribeCount('sess-alpha-one-long-id') === 1, 'superseded watcher released');
    assert.equal(bridge.getCurrentSessionId(), 'sess-beta-one-long-id');
  });

  it('the command menu advertises /follow', () => {
    const commands = bot.commandMenu.map((entry) => entry.command);
    assert.ok(commands.includes('follow'), 'the Telegram command menu should list /follow');
  });

  it('reports agent stream errors', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('break please');
    await until(() => bridge.watcherCount() > 0, 'watcher registration');

    bridge.emit('sess-alpha-one-long-id', 'onError', 'model exploded');
    const sent = await mock.waitForText('Agent error', 2000);
    assert.ok(textOf(sent).includes('model exploded'));
  });

  it('unauthorized users are rejected for messages and callbacks', async () => {
    const update = mock.pushText({ chatId: CHAT_ID, userId: STRANGER, text: '/projects' });
    await deliver(mock, bot, update);
    const rejected = await mock.waitForText('Not authorized', 2000);
    assert.ok(textOf(rejected).includes(String(STRANGER)), 'the user id is echoed back for allow-listing');
    assert.equal(bridge.calls.some((c) => c.method === 'listProjects'), false);

    mock.reset();
    const callback = mock.pushCallback({ chatId: CHAT_ID, userId: STRANGER, data: 'p:wp-alpha' });
    await deliver(mock, bot, callback);
    const ack = await mock.waitFor((call) => call.method === 'answerCallbackQuery', 2000);
    assert.equal(ack.body.show_alert, true);
    assert.equal(bridge.getCurrentProjectId(), null, 'a rejected callback must not switch projects');
  });

  it('an empty allow-list lets any user operate the bot', async () => {
    const openBot = createBot({ api, bridge, config: { allowedUsers: [] }, logger });
    try {
      await openBot.handleUpdate(mock.pushText({ chatId: CHAT_ID, userId: STRANGER, text: '/status' }));
      const sent = await mock.waitForText('Status', 2000);
      assert.ok(textOf(sent).includes('Status'));
    } finally {
      openBot.stop();
    }
  });

  it('ignores updates it cannot route', async () => {
    await bot.handleUpdate(undefined);
    await bot.handleUpdate(null);
    await bot.handleUpdate({ update_id: 1 });
    await bot.handleUpdate({ update_id: 2, message: {} });
    assert.equal(mock.calls.length, 0, 'unroutable updates must not produce traffic');
  });

  it('unknown commands get a helpful hint', async () => {
    await say('/frobnicate');
    const sent = await mock.waitForText('Unknown command', 2000);
    assert.ok(textOf(sent).includes('/help'));
  });

  it('an unknown callback payload is reported, not swallowed', async () => {
    await tap('bogus:payload');
    const sent = await mock.waitForText('Unsupported action', 2000);
    assert.ok(textOf(sent).includes('bogus:payload'));
  });

  it('long-polling delivers pushed updates through the poller', async () => {
    const poller = createPoller({
      api,
      bot,
      config: { pollTimeoutSeconds: 5 },
      logger,
    });
    try {
      poller.start();
      // Wait until the loop is actually long-polling before pushing.
      await mock.waitFor((call) => call.method === 'getUpdates', 2000);
      mock.pushText({ chatId: CHAT_ID, userId: GOOD_USER, text: '/start' });
      const sent = await mock.waitForText('DeepSeek Harness → Telegram', 4000);
      assert.equal(sent.method, 'sendMessage');

      // The poller advances the offset so the same update is not redelivered.
      const pollCall = mock.lastCall('getUpdates');
      assert.equal(typeof pollCall.body.offset, 'number');
    } finally {
      await poller.stop();
    }
  });

  it('stop() detaches watchers and silences further updates', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('hello');
    await until(() => bridge.watcherCount() > 0, 'watcher registration');

    bot.stop();
    assert.equal(bridge.watcherCount(), 0, 'stop() must unsubscribe bridge watchers');

    mock.reset();
    await say('/status');
    assert.equal(mock.calls.length, 0, 'a stopped bot must ignore updates');
  });

  it('render help and status are exported for direct assertions', () => {    const help = renderHelp({ hostname: 'h1' }, 'sess-alpha-one-long-id');
    assert.ok(help.includes('DeepSeek Harness → Telegram'));
    assert.ok(help.includes('h1'));

    const status = renderStatus({
      project: { id: 'p', title: 'P', path: 'C:\\p' },
      session: { sessionId: 'sess-x', title: 'T', running: false },
      host: { hostname: 'h2' },
    });
    assert.ok(status.includes('*Status*'));
    assert.ok(status.includes('C:\\p'));
    assert.ok(status.includes('sess-x'));
  });

  it('splits oversized assistant output instead of exceeding the Bot API limit', async () => {
    bridge.setCurrentProject('wp-alpha');
    bridge.setCurrentSession('sess-alpha-one-long-id');
    await say('write a lot');
    await until(() => bridge.watcherCount() > 0, 'watcher registration');

    const huge = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');
    bridge.emit('sess-alpha-one-long-id', 'onAssistant', huge);
    await mock.waitFor((call) => call.method === 'sendMessage', 3000);

    const sent = mock.callsOf('sendMessage');
    assert.ok(sent.length >= 1);
    for (const call of sent) {
      assert.ok(call.body.text.length <= 4096, 'each chunk must fit the Telegram limit');
    }
  });
});
