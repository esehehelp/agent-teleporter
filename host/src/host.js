import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import WebSocket from 'ws';
import { startDirect } from './direct.js';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const send = (socket, data) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };

export class Host {
  constructor({ url, token, bind, port = 8787, id = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), cwd = process.cwd(), socketPath = path.join(os.homedir(), '.cache', 'agent-teleporter', 'host.sock') }) {
    if ((!url && !bind) || !token || !validId(id)) throw new Error('Set TELEPORTER_TOKEN and TELEPORTER_URL and/or TELEPORTER_BIND');
    if (url) {
      const parsed = new URL(url);
      if (!['wss:', 'ws:'].includes(parsed.protocol) || (parsed.protocol === 'ws:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)))
        throw new Error('Remote URL must use wss:// (ws:// allowed only for localhost)');
    }
    this.url = url; this.bind = bind; this.port = port; this.token = token; this.id = id; this.cwd = path.resolve(cwd); this.socketPath = socketPath;
    this.sessions = new Map(); this.subscribers = new Map(); this.messages = new Map();
    this.closed = false; this.retry = 1000;
  }
  start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.socketPath)) {
      // Never unlink another process's socket.
      const s = net.connect(this.socketPath);
      s.once('connect', () => { s.destroy(); console.error('Host already running at ' + this.socketPath); process.exitCode = 1; this.stop(); });
      s.once('error', e => { if (e.code === 'ECONNREFUSED') { fs.unlinkSync(this.socketPath); this.listen(); } else throw e; });
    } else this.listen();
    if (this.bind) this.direct = startDirect(this, this.bind, this.port);
    if (this.url) this.connect();
  }
  listen() {
    this.server = net.createServer(sock => this.local(sock));
    this.server.listen(this.socketPath, () => fs.chmodSync(this.socketPath, 0o600));
  }
  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { maxPayload: 65536 });
    this.ws = ws;
    ws.on('open', () => send(ws, { type: 'auth', role: 'host', id: this.id, token: this.token }));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'ready') { this.retry = 1000; this.announce(); }
      else this.remote(m);
    });
    ws.on('error', e => console.error('Relay:', e.message));
    ws.on('close', () => {
      if (this.closed) return;
      this.timer = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30000);
    });
  }
  announce() {
    send(this.ws, { type: 'sessions', sessions: [...this.sessions].map(([id, s]) => ({ id, harness: s.harness })) });
    this.direct?.announce();
  }
  create(id, harness) {
    if (!validId(id) || !['pi', 'claude'].includes(harness) || this.sessions.has(id) || this.sessions.size >= 64) return false;
    const command = harness === 'pi' ? 'pi' : 'claude';
    const hook = `node ${JSON.stringify(fileURLToPath(new URL('./claude-hook.js', import.meta.url)))}`;
    const args = harness === 'pi' ? ['-e', fileURLToPath(new URL('./pi-messages.ts', import.meta.url))] :
      ['--settings', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }] } })];
    // PTY is owned by the local host. No remote shell commands or arbitrary cwd.
    let term;
    try {
      term = pty.spawn(command, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: this.cwd,
        env: { ...process.env, TERM: 'xterm-256color', TELEPORTER_SESSION: id, TELEPORTER_SOCKET: this.socketPath } });
    } catch (e) { console.error(`Cannot start ${command}: ${e.message}`); return false; }
    const session = { harness, term, replay: '', exited: false };
    this.sessions.set(id, session);
    term.onData(data => {
      session.replay = (session.replay + data).slice(-32768);
      for (let i = 0; i < data.length; i += 16000) {
        const part = data.slice(i, i + 16000);
        send(this.ws, { type: 'output', session: id, data: part });
        this.direct?.output(id, part);
      }
    });
    term.onExit(({ exitCode }) => {
      session.exited = true;
      const ending = `\r\n[${harness} exited: ${exitCode}]\r\n`;
      send(this.ws, { type: 'output', session: id, data: ending });
      this.direct?.output(id, ending);
      this.sessions.delete(id); this.announce();
    });
    this.announce(); return true;
  }
  pairing(to) {
    if (!validId(to)) return null;
    const base = this.bind ? `http://${this.bind}:${this.port}/` : this.url?.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '/');
    if (!base) return null;
    const url = new URL(base);
    url.hash = `token=${encodeURIComponent(this.token)}`;
    let wg = null;
    if (process.env.TELEPORTER_WG_CLIENT_CONFIG) {
      try {
        const file = process.env.TELEPORTER_WG_CLIENT_CONFIG;
        if (fs.statSync(file).size <= 8192) wg = fs.readFileSync(file, 'utf8');
      } catch (e) { console.error('Pairing config unavailable:', e.message); }
    }
    return { type: 'pairing', to, url: url.toString(), wg };
  }
  remote(m) {
    if (m.type === 'pair') { const payload = this.pairing(m.to); if (payload) send(this.ws, payload); return; }
    if (m.type === 'create') { this.create(m.session, m.harness); return; }
    if (!validId(m.session)) return;
    const s = this.sessions.get(m.session);
    if (!s) return;
    try {
      if (m.type === 'input' && typeof m.data === 'string' && m.data.length <= 8192) s.term.write(m.data);
      else if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols >= 20 && m.cols <= 400 && m.rows >= 5 && m.rows <= 150) s.term.resize(m.cols, m.rows);
      else if (m.type === 'replay') send(this.ws, { type: 'output', session: m.session, data: s.replay });
      else if (m.type === 'send' && validId(m.to) && typeof m.text === 'string') this.deliver(m.session, m.to, m.text);
    } catch (e) { console.error('PTY:', e.message); }
  }
  deliver(from, to, text) {
    if (!validId(from) || !validId(to) || !this.sessions.has(from) || !this.sessions.has(to) || typeof text !== 'string' || !text.trim() || text.length > 4096) return false;
    const msg = { type: 'message', id: randomUUID(), from, to, text, at: new Date().toISOString() };
    const inbox = this.messages.get(to) || [];
    inbox.push(msg); if (inbox.length > 100) inbox.shift(); this.messages.set(to, inbox);
    for (const client of this.subscribers.get(to) || []) client.write(JSON.stringify(msg) + '\n');
    send(this.ws, { type: 'message', session: to, from, text });
    this.direct?.message(to, from, text);
    return true;
  }
  local(sock) {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', chunk => {
      buf += chunk;
      if (buf.length > 8192) { sock.destroy(); return; }
      const end = buf.indexOf('\n'); if (end < 0) return;
      const line = buf.slice(0, end); buf = '';
      let m; try { m = JSON.parse(line); } catch { sock.end('{"error":"invalid JSON"}\n'); return; }
      if (!validId(m.session) || !this.sessions.has(m.session)) { sock.end('{"error":"unknown session"}\n'); return; }
      if (m.action === 'send') {
        const ok = this.deliver(m.session, m.to, m.text);
        sock.end(JSON.stringify({ ok }) + '\n');
      } else if (m.action === 'inbox' || m.action === 'drain') {
        const msgs = this.messages.get(m.session) || [];
        if (m.action === 'drain') this.messages.set(m.session, []);
        sock.end(JSON.stringify(msgs) + '\n');
      }
      else if (m.action === 'subscribe') {
        const set = this.subscribers.get(m.session) || new Set();
        set.add(sock); this.subscribers.set(m.session, set);
        for (const msg of this.messages.get(m.session) || []) sock.write(JSON.stringify(msg) + '\n');
        sock.on('close', () => set.delete(sock));
      } else sock.end('{"error":"unknown action"}\n');
    });
  }
  stop() {
    this.closed = true; clearTimeout(this.timer); this.ws?.close(); this.server?.close(); this.direct?.close();
    for (const s of this.sessions.values()) s.term.kill();
    if (this.server && fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
  }
}
