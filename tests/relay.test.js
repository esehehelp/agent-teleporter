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
  const remote = await open('server', 'host');
  const viewer = await open('phone', 'viewer');
  const other = await open('tablet', 'viewer');
  assert.ok(viewer.sent.some(m => m.type === 'hosts'));
  viewer.receive({ type: 'create', host: 'laptop', session: 'a', harness: 'pi' });
  assert.ok(host.sent.some(m => m.type === 'create' && m.session === 'a'));
  host.receive({ type: 'sessions', sessions: [{ id: 'a', harness: 'pi' }] });
  remote.receive({ type: 'sessions', sessions: [{ id: 'b', harness: 'claude' }] });
  viewer.receive({ type: 'watch', host: 'laptop', session: 'a' });
  other.receive({ type: 'watch', host: 'server', session: 'b' });
  assert.ok(viewer.sent.some(m => m.type === 'watching' && m.session === 'a'));
  viewer.receive({ type: 'input', host: 'laptop', session: 'a', data: 'hello\r' });
  assert.ok(host.sent.some(m => m.type === 'input' && m.data === 'hello\r'));
  viewer.receive({ type: 'input', host: 'laptop', session: 'missing', data: 'wrong' });
  assert.ok(!host.sent.some(m => m.data === 'wrong'));
  host.receive({ type: 'output', session: 'a', data: 'hello' });
  assert.ok(viewer.sent.some(m => m.type === 'output' && m.data === 'hello'));
  assert.ok(!other.sent.some(m => m.type === 'output' && m.data === 'hello'));
  viewer.receive({ type: 'replay', host: 'laptop', session: 'a' });
  assert.ok(host.sent.some(m => m.type === 'replay' && m.to === 'phone'));
  host.receive({ type: 'replay_output', to: 'phone', session: 'a', data: 'history' });
  assert.ok(viewer.sent.some(m => m.type === 'output' && m.data === 'history'));
  assert.ok(!other.sent.some(m => m.type === 'output' && m.data === 'history'));
  viewer.receive({ type: 'send', host: 'laptop', session: 'a', toHost: 'server', to: 'b', text: 'please review' });
  assert.ok(remote.sent.some(m => m.type === 'deliver' && m.from === 'laptop/a' && m.to === 'b'));
  host.receive({ type: 'forward', session: 'a', toHost: 'server', to: 'b', text: 'from CLI' });
  assert.ok(remote.sent.some(m => m.type === 'deliver' && m.text === 'from CLI'));
  remote.receive({ type: 'message', session: 'b', from: 'laptop/a', text: 'hello' });
  assert.ok(other.sent.some(m => m.type === 'message' && m.text === 'hello'));
  assert.ok(!viewer.sent.some(m => m.type === 'message' && m.text === 'hello'));
  viewer.receive({ type: 'pair', host: 'laptop' });
  assert.ok(host.sent.some(m => m.type === 'pair' && m.to === 'phone'));
  host.receive({ type: 'pairing', to: 'phone', url: 'http://10.77.0.1:8787/#token=secret', wg: '[Interface]' });
  assert.ok(viewer.sent.some(m => m.type === 'pairing' && m.wg === '[Interface]'));
  assert.ok(!other.sent.some(m => m.type === 'pairing'));
  // Reconnection reclaims the same host identity without leaving two routes active.
  const replacement = await open('laptop', 'host');
  assert.equal(host.code, 1000);
  assert.equal([...relay.peers.values()].filter(p => p.role === 'host' && p.id === 'laptop').length, 1);
  host.close(); remote.close(); replacement.close(); viewer.close(); other.close();
});

test('host messages reach local subscribers and are bounded', () => {
  const host = new Host({ url: 'wss://example.com/ws', token: 'secret' });
  host.sessions.set('pi', {}); host.sessions.set('claude', {});
  const lines = []; host.subscribers.set('claude', new Set([{ write: s => lines.push(JSON.parse(s)) }]));
  assert.equal(host.deliver('pi', 'claude', 'review this'), true);
  assert.equal(lines[0].text, 'review this');
  assert.equal(lines[0].from, `${host.id}/pi`);
  const forwarded = [];
  host.ws = { readyState: 1, send: s => forwarded.push(JSON.parse(s)) };
  assert.equal(host.deliver('pi', 'remote/claude', 'review across hosts'), true);
  assert.deepEqual(forwarded[0], { type: 'forward', session: 'pi', toHost: 'remote', to: 'claude', text: 'review across hosts' });
  host.remote({ type: 'deliver', from: 'remote/agent', to: 'claude', text: 'done' });
  assert.equal(lines.at(-1).from, 'remote/agent');
  assert.equal(host.deliver('pi', 'other', 'bad'), false);
  assert.equal(host.deliver('pi', 'claude', 'a'.repeat(4097)), false);
});
