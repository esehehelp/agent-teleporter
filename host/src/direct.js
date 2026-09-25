import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const publicDir = fileURLToPath(new URL('../../worker/public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const validId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
// A direct HTTP transport must never listen on a public interface. Use WireGuard's private IPv4.
export function privateBind(ip) {
  if (ip === '127.0.0.1') return true; // development
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

export function startDirect(host, ip, port = 8787) {
  if (!privateBind(ip)) throw new Error('Direct HTTP must bind to a WireGuard private IPv4 (or 127.0.0.1 for tests)');
  const peers = new Map(); // socket -> {id, watching: session|null}
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name = pathname === '/' ? '/index.html' : pathname;
    if (!/^\/[a-zA-Z0-9._-]+$/.test(name)) { res.writeHead(404); res.end(); return; }
    const file = path.join(publicDir, name);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (req, sock, head) => {
    if (req.url !== '/ws') { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws));
  });
  const roster = () => ({ type: 'hosts', hosts: [{ id: host.id,
    sessions: [...host.sessions].map(([id, s]) => ({ id, harness: s.harness })) }] });
  const announce = () => { for (const ws of peers.keys()) send(ws, roster()); };
  wss.on('connection', ws => {
    const timeout = setTimeout(() => ws.close(1008, 'Authentication timeout'), 5000);
    let viewerId;
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { ws.close(1003); return; }
      if (!peers.has(ws)) {
        if (m.type !== 'auth' || m.role !== 'viewer' || !validId(m.id) || m.token !== host.token) { ws.close(1008); return; }
        clearTimeout(timeout); viewerId = m.id; peers.set(ws, { watching: null }); send(ws, { type: 'ready' }); send(ws, roster()); return;
      }
      if (m.host !== host.id) return;
      if (m.type === 'watch') {
        peers.get(ws).watching = validId(m.session) && host.sessions.has(m.session) ? m.session : null;
        send(ws, { type: 'watching', host: host.id, session: peers.get(ws).watching });
      } else if (m.type === 'pair') {
        const payload = host.pairing(viewerId);
        if (payload) send(ws, { ...payload, host: host.id });
      } else if (m.type === 'create' && validId(m.session) && ['pi', 'claude'].includes(m.harness)) host.create(m.session, m.harness);
      else if (validId(m.session) && host.sessions.has(m.session)) {
        if (m.type === 'input' && typeof m.data === 'string' && m.data.length <= 8192) host.remote(m);
        else if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) host.remote(m);
        else if (m.type === 'replay') send(ws, { type: 'output', host: host.id, session: m.session, data: host.sessions.get(m.session).replay });
        else if (m.type === 'send' && m.toHost === host.id && validId(m.to) && typeof m.text === 'string')
          host.deliver(m.session, m.to, m.text);
      }
    });
    ws.on('close', () => { clearTimeout(timeout); peers.delete(ws); });
  });
  const output = (session, data) => { for (const [ws, p] of peers) if (p.watching === session) send(ws, { type: 'output', host: host.id, session, data }); };
  const message = (session, from, text) => { for (const [ws, p] of peers) if (p.watching === session) send(ws, { type: 'message', host: host.id, session, from, text }); };
  server.listen(port, ip);
  return { server, wss, announce, output, message, close: () => { for (const ws of peers.keys()) ws.terminate(); wss.close(); server.close(); } };
}
