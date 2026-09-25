// All sockets share one Durable Object, so host/viewer routing is serialized.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      return new Response(asset.body, { status: asset.status, headers });
    }
    if (!env.REMOTE_TOKEN || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Unavailable', { status: 400 });
    return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(request);
  },
};

const MAX_FRAME = 65536;
const validId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const send = (ws, data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };
async function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const x = await digest(a), y = await digest(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
export class Relay {
  constructor(_state, env) {
    this.token = env.REMOTE_TOKEN;
    this.peers = new Map(); // socket -> {role,id, sessions}
  }
  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const timer = setTimeout(() => server.close(1008, 'Authentication timeout'), 5000);
    server.addEventListener('message', async event => {
      if (typeof event.data !== 'string' || event.data.length > MAX_FRAME) { server.close(1009, 'Frame too large'); return; }
      let msg;
      try { msg = JSON.parse(event.data); } catch { server.close(1003, 'Invalid JSON'); return; }
      let peer = this.peers.get(server);
      if (!peer) {
        if (msg.type !== 'auth' || !['host', 'viewer'].includes(msg.role) ||
            !validId(msg.id) || !(await equal(msg.token, this.token)) ||
            [...this.peers.values()].some(p => p.role === msg.role && p.id === msg.id)) {
          server.close(1008, 'Unauthorized'); return;
        }
        clearTimeout(timer);
        peer = { role: msg.role, id: msg.id, sessions: [] };
        this.peers.set(server, peer);
        send(server, { type: 'ready' });
        this.broadcastHosts();
        return;
      }
      this.route(server, peer, msg);
    });
    server.addEventListener('close', () => {
      clearTimeout(timer);
      const peer = this.peers.get(server);
      this.peers.delete(server);
      if (peer?.role === 'host') this.broadcastHosts();
    });
    server.addEventListener('error', () => { clearTimeout(timer); this.peers.delete(server); });
    return new Response(null, { status: 101, webSocket: client });
  }
  broadcastHosts() {
    const hosts = [...this.peers.values()].filter(p => p.role === 'host').map(p => ({ id: p.id, sessions: p.sessions }));
    for (const [ws, peer] of this.peers) if (peer.role === 'viewer') send(ws, { type: 'hosts', hosts });
  }
  route(ws, peer, m) {
    if (peer.role === 'host') {
      if (m.type === 'sessions' && Array.isArray(m.sessions) && m.sessions.length <= 64 &&
          m.sessions.every(s => validId(s.id) && ['pi', 'claude'].includes(s.harness))) {
        peer.sessions = m.sessions.map(s => ({ id: s.id, harness: s.harness }));
        this.broadcastHosts();
      } else if (m.type === 'output' && validId(m.session) && typeof m.data === 'string' && m.data.length <= 32768 &&
                 peer.sessions.some(s => s.id === m.session)) {
        for (const [target, p] of this.peers) if (p.role === 'viewer') send(target, { type: 'output', host: peer.id, session: m.session, data: m.data });
      } else if (m.type === 'message' && validId(m.session) && typeof m.text === 'string' && m.text.length <= 4096) {
        for (const [target, p] of this.peers) if (p.role === 'viewer') send(target, { type: 'message', host: peer.id, session: m.session, from: m.from, text: m.text });
      } else if (m.type === 'pairing' && validId(m.to) && typeof m.url === 'string' && m.url.length <= 2048 &&
                 (m.wg === null || typeof m.wg === 'string' && m.wg.length <= 8192)) {
        for (const [target, p] of this.peers) if (p.role === 'viewer' && p.id === m.to)
          send(target, { type: 'pairing', host: peer.id, url: m.url, wg: m.wg });
      }
      return;
    }
    if (!validId(m.host)) return;
    const host = [...this.peers].find(([, p]) => p.role === 'host' && p.id === m.host);
    if (!host) return;
    if (m.type === 'pair') { send(host[0], { type: 'pair', to: peer.id }); return; }
    if (m.type === 'create' && ['pi', 'claude'].includes(m.harness) && validId(m.session))
      send(host[0], { type: 'create', session: m.session, harness: m.harness });
    else if (validId(m.session) && host[1].sessions.some(s => s.id === m.session)) {
      if (m.type === 'input' && typeof m.data === 'string' && m.data.length <= 8192)
        send(host[0], { type: 'input', session: m.session, data: m.data });
      else if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) &&
               m.cols >= 20 && m.cols <= 400 && m.rows >= 5 && m.rows <= 150)
        send(host[0], { type: 'resize', session: m.session, cols: m.cols, rows: m.rows });
      else if (m.type === 'replay') send(host[0], { type: 'replay', session: m.session });
      else if (m.type === 'send' && validId(m.to) && typeof m.text === 'string' && m.text.length <= 4096)
        send(host[0], { type: 'send', session: m.session, to: m.to, text: m.text });
    }
  }
}
