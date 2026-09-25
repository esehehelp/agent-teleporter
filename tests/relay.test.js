import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Relay } from '../worker/src/index.js';
import { Host } from '../host/src/host.js';

class Socket extends EventEmitter {
  readyState = 1; sent = [];
  accept() {}
  addEventListener(name, fn) { this.on(name, fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
  receive(msg) { this.emit('message', { data: JSON.stringify(msg) }); }
}
globalThis.WebSocketPair = class { constructor() { this.client = new Socket(); this.server = new Socket(); } };
// Node's Response disallows status 101; Workers supports WebSocket upgrade responses.
globalThis.Response = class { constructor(_body, options) { Object.assign(this, options); } };
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

test('relay authenticates, routes PTY commands and prevents host spoofing', async () => {
  const relay = new Relay({}, { REMOTE_TOKEN: 'secret' });
  // Replace the pair with one that exposes the server to this test.
  let lastServer;
  globalThis.WebSocketPair = class { constructor() { this.client = new Socket(); lastServer = this.server = new Socket(); } };
  const open = async (id, role, token = 'secret') => {
    await relay.fetch(); const s = lastServer; s.receive({ type: 'auth', role, id, token }); await flush(); return s;
  };
  const bad = await open('bad', 'viewer', 'wrong'); assert.equal(bad.code, 1008);
  const host = await open('laptop', 'host');
  const viewer = await open('phone', 'viewer');
  const other = await open('tablet', 'viewer');
  assert.ok(viewer.sent.some(m => m.type === 'hosts'));
  viewer.receive({ type: 'create', host: 'laptop', session: 'a', harness: 'pi' });
  assert.ok(host.sent.some(m => m.type === 'create' && m.session === 'a'));
  host.receive({ type: 'sessions', sessions: [{ id: 'a', harness: 'pi' }] });
  viewer.receive({ type: 'input', host: 'laptop', session: 'a', data: 'hello\r' });
  assert.ok(host.sent.some(m => m.type === 'input' && m.data === 'hello\r'));
  viewer.receive({ type: 'input', host: 'laptop', session: 'missing', data: 'wrong' });
  assert.ok(!host.sent.some(m => m.data === 'wrong'));
  host.receive({ type: 'output', session: 'a', data: 'hello' });
  assert.ok(viewer.sent.some(m => m.type === 'output' && m.data === 'hello'));
  viewer.receive({ type: 'pair', host: 'laptop' });
  assert.ok(host.sent.some(m => m.type === 'pair' && m.to === 'phone'));
  host.receive({ type: 'pairing', to: 'phone', url: 'http://10.77.0.1:8787/#token=secret', wg: '[Interface]' });
  assert.ok(viewer.sent.some(m => m.type === 'pairing' && m.wg === '[Interface]'));
  assert.ok(!other.sent.some(m => m.type === 'pairing'));
  host.close(); viewer.close(); other.close();
});

test('host messages reach local subscribers and are bounded', () => {
  const host = new Host({ url: 'wss://example.com/ws', token: 'secret' });
  host.sessions.set('pi', {}); host.sessions.set('claude', {});
  const lines = []; host.subscribers.set('claude', new Set([{ write: s => lines.push(JSON.parse(s)) }]));
  assert.equal(host.deliver('pi', 'claude', 'review this'), true);
  assert.equal(lines[0].text, 'review this');
  assert.equal(host.deliver('pi', 'other', 'bad'), false);
  assert.equal(host.deliver('pi', 'claude', 'a'.repeat(4097)), false);
});
