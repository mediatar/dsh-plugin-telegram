// Self-tests for the local Bot API mock. These do not touch lib/ at all, so
// they stay green even while the plugin implementation is still landing.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startMockBotApi } from './mock-bot-api.js';

const TOKEN = '987654:mock-selftest';

/** Minimal Bot API client used only by these self-tests. */
async function callBot(baseUrl, token, method, payload = {}, { asGet = false } = {}) {
  const url = `${baseUrl}/bot${token}/${method}`;
  if (asGet) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
    );
    const res = await fetch(`${url}?${qs}`);
    return res.json();
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(
      Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
    ),
  });
  return res.json();
}

describe('mock Bot API', () => {
  /** @type {Awaited<ReturnType<typeof startMockBotApi>>} */
  let api;

  before(async () => {
    api = await startMockBotApi({ token: TOKEN });
  });

  after(async () => {
    await api.close();
  });

  it('serves getMe over POST and GET', async () => {
    const viaPost = await callBot(api.baseUrl, TOKEN, 'getMe');
    assert.equal(viaPost.ok, true);
    assert.equal(viaPost.result.username, 'dsh_test_bot');

    const viaGet = await callBot(api.baseUrl, TOKEN, 'getMe', {}, { asGet: true });
    assert.equal(viaGet.ok, true);
    assert.equal(viaGet.result.is_bot, true);

    assert.equal(api.callsOf('getMe').length, 2);
    assert.equal(api.calls[0].method, 'getMe');
    assert.ok(typeof api.calls[0].at === 'number');
  });

  it('rejects a wrong token path', async () => {
    const res = await callBot(api.baseUrl, 'nope', 'getMe');
    assert.equal(res.ok, false);
    assert.equal(res.error_code, 401);
  });

  it('returns 404 for an unknown method', async () => {
    const res = await callBot(api.baseUrl, TOKEN, 'notAMethod');
    assert.equal(res.ok, false);
    assert.equal(res.error_code, 404);
  });

  it('returns immediately for getUpdates with timeout=0 and empty queue', async () => {
    api.reset();
    const started = Date.now();
    const res = await callBot(api.baseUrl, TOKEN, 'getUpdates', { timeout: 0 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.result, []);
    assert.ok(Date.now() - started < 1000, 'timeout=0 must not block');
  });

  it('delivers pushed text updates with offset acknowledgement', async () => {
    api.reset();
    const { update_id: firstId } = api.pushText({ chatId: 42, userId: 7, text: 'hello' });
    const res = await callBot(api.baseUrl, TOKEN, 'getUpdates', { offset: 0, timeout: 0 });
    assert.equal(res.result.length, 1);
    assert.equal(res.result[0].update_id, firstId);
    assert.equal(res.result[0].message.text, 'hello');
    assert.equal(res.result[0].message.chat.id, 42);
    assert.equal(res.result[0].message.from.id, 7);

    // Re-polling without advancing the offset must not redeliver.
    const again = await callBot(api.baseUrl, TOKEN, 'getUpdates', { offset: 0, timeout: 0 });
    assert.deepEqual(again.result, []);
  });

  it('long-polls and resolves as soon as an update is pushed', async () => {
    api.reset();
    const started = Date.now();
    const poll = callBot(api.baseUrl, TOKEN, 'getUpdates', { timeout: 10 });
    // Give the request a moment to register as a waiter, then push.
    await new Promise((resolve) => setTimeout(resolve, 60));
    api.pushText({ chatId: 55, userId: 8, text: 'wake up' });
    const res = await poll;
    assert.equal(res.result.length, 1);
    assert.equal(res.result[0].message.text, 'wake up');
    assert.ok(Date.now() - started < 5000, 'long poll should resolve early');
  });

  it('emits callback_query updates', async () => {
    api.reset();
    api.pushCallback({ chatId: 77, userId: 9, data: 'project:abc' });
    const res = await callBot(api.baseUrl, TOKEN, 'getUpdates', { timeout: 0 });
    assert.equal(res.result.length, 1);
    const cb = res.result[0].callback_query;
    assert.equal(cb.data, 'project:abc');
    assert.equal(cb.message.chat.id, 77);
    assert.equal(typeof cb.id, 'string');
  });

  it('records outbound sendMessage calls including reply_markup', async () => {
    api.reset();
    const markup = JSON.stringify({
      inline_keyboard: [[{ text: 'One', callback_data: 'p:1' }]],
    });
    const res = await callBot(api.baseUrl, TOKEN, 'sendMessage', {
      chat_id: 42,
      text: 'pick one',
      reply_markup: markup,
    });
    assert.equal(res.ok, true);

    const call = api.lastCall('sendMessage');
    assert.equal(call.body.chat_id, '42');
    assert.equal(call.body.text, 'pick one');
    assert.deepEqual(call.body.reply_markup, {
      inline_keyboard: [[{ text: 'One', callback_data: 'p:1' }]],
    });

    const found = await api.waitForText('pick one', 1000);
    assert.equal(found.method, 'sendMessage');
  });

  it('rejects empty sendMessage text like Telegram does', async () => {
    api.reset();
    const res = await callBot(api.baseUrl, TOKEN, 'sendMessage', { chat_id: 42, text: '' });
    assert.equal(res.ok, false);
    assert.equal(res.error_code, 400);
    assert.ok(api.callsOf('sendMessage')[0].error);
  });

  it('records editMessageText, answerCallbackQuery, sendChatAction, deleteMessage, setMyCommands', async () => {
    api.reset();
    const results = await Promise.all([
      callBot(api.baseUrl, TOKEN, 'editMessageText', {
        chat_id: 42,
        message_id: 5,
        text: 'edited',
      }),
      callBot(api.baseUrl, TOKEN, 'answerCallbackQuery', { callback_query_id: 'x' }),
      callBot(api.baseUrl, TOKEN, 'sendChatAction', { chat_id: 42, action: 'typing' }),
      callBot(api.baseUrl, TOKEN, 'deleteMessage', { chat_id: 42, message_id: 5 }),
      callBot(api.baseUrl, TOKEN, 'setMyCommands', { commands: '[]' }),
    ]);
    for (const res of results) assert.equal(res.ok, true);

    const methods = api.calls.map((c) => c.method).sort();
    assert.deepEqual(methods, [
      'answerCallbackQuery',
      'deleteMessage',
      'editMessageText',
      'sendChatAction',
      'setMyCommands',
    ]);
    assert.equal(api.callsOf('editMessageText')[0].body.text, 'edited');
    assert.equal(api.callsOf('sendChatAction')[0].body.action, 'typing');
  });

  it('waitFor times out with a helpful message', async () => {
    api.reset();
    await assert.rejects(() => api.waitFor(() => false, 50), /waitFor timed out/);
  });

  it('exposes an ephemeral port and a usable baseUrl', () => {
    assert.ok(api.port > 0);
    assert.equal(api.baseUrl, `http://127.0.0.1:${api.port}`);
  });
});
