import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Host } from '../host/src/host.js';
import { privateBind, startDirect } from '../host/src/direct.js';

const open = url => new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.once('open', () => resolve(ws)); ws.once('error', reject); });
test('direct listener rejects public binds', () => {
  assert.equal(privateBind('0.0.0.0'), false);
  assert.equal(privateBind('8.8.8.8'), false);
  assert.equal(privateBind('10.77.0.1'), true);
  assert.equal(privateBind('172.16.0.1'), true);
  assert.equal(privateBind('192.168.2.1'), true);
});
test('local WireGuard transport serves UI and routes authorized terminal input', async () => {
  const host = new Host({ bind: '127.0.0.1', token: 'test' });
  const input = [];
  host.sessions.set('alpha', { harness: 'pi', replay: 'hello', term: { write: data => input.push(data) } });
  const direct = startDirect(host, '127.0.0.1', 0); host.direct = direct;
  await new Promise(resolve => direct.server.once('listening', resolve));
  const port = direct.server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Agent Teleporter/);
    const bad = await open(`ws://127.0.0.1:${port}/ws`);
    const denied = new Promise(resolve => bad.once('close', resolve));
    bad.send(JSON.stringify({ type: 'auth', role: 'viewer', id: 'bad', token: 'wrong' }));
    assert.equal(await denied, 1008);
    const ws = await open(`ws://127.0.0.1:${port}/ws`);
    const initial = new Promise(resolve => {
      const messages = [];
      ws.on('message', raw => { messages.push(JSON.parse(raw.toString())); if (messages.length === 2) resolve(messages); });
    });
    ws.send(JSON.stringify({ type: 'auth', role: 'viewer', id: 'mobile', token: 'test' }));
    assert.deepEqual((await initial).map(m => m.type), ['ready', 'hosts']);
    ws.send(JSON.stringify({ type: 'input', host: host.id, session: 'alpha', data: 'prompt\r' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(input, ['prompt\r']);
    ws.close();
  } finally { direct.close(); }
});
