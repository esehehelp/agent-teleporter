import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import QRCode from 'qrcode';
import '@xterm/xterm/css/xterm.css';
const $ = id => document.getElementById(id);
const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 3000, theme: { background: '#111827' } });
const fit = new FitAddon(); term.loadAddon(fit); term.open($('terminal'));
const state = { ws: null, hosts: [], host: '', session: '', watchKey: '', retry: null, ready: false };
const emit = m => { if (state.ws?.readyState === WebSocket.OPEN && state.ready) state.ws.send(JSON.stringify(m)); };
const selected = () => ({ host: state.host, session: state.session });
const option = (select, value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; select.append(o); };
function render() {
  const host = $('host'), session = $('session'), target = $('target');
  const oldHost = state.host, oldSession = state.session, oldTarget = target.value;
  host.replaceChildren(); session.replaceChildren(); target.replaceChildren();
  for (const h of state.hosts) option(host, h.id, h.id);
  state.host = state.hosts.find(h => h.id === oldHost)?.id || state.hosts[0]?.id || '';
  host.value = state.host;
  for (const s of state.hosts.find(h => h.id === state.host)?.sessions || [])
    option(session, s.id, `${s.id} (${s.harness})`);
  for (const h of state.hosts) for (const s of h.sessions)
    option(target, `${h.id}/${s.id}`, `${h.id}/${s.id} (${s.harness})`);
  if ([...target.options].some(o => o.value === oldTarget)) target.value = oldTarget;
  state.session = [...session.options].some(o => o.value === oldSession) ? oldSession : session.options[0]?.value || '';
  session.value = state.session;
  if (oldHost !== state.host || oldSession !== state.session) { term.clear(); state.watchKey = ''; }
  if (state.session && state.watchKey !== `${state.host}/${state.session}`) emit({ type: 'watch', ...selected() });
  fit.fit(); resize();
}
function resize() { if (state.session) emit({ type: 'resize', ...selected(), cols: term.cols, rows: term.rows }); }
function connect() {
  clearTimeout(state.retry);
  if (state.ws) state.ws.close();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  state.ws = ws; state.ready = false; $('status').textContent = 'Connecting…';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', role: 'viewer', id: Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''), token: $('token').value }));
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'ready') { state.ready = true; state.host = ''; state.session = ''; state.watchKey = ''; $('status').textContent = 'Connected'; $('login').hidden = true; }
    if (m.type === 'hosts') { state.hosts = m.hosts; render(); }
    if (m.type === 'watching' && m.host === state.host && m.session === state.session) {
      state.watchKey = `${m.host}/${m.session}`;
      emit({ type: 'replay', ...selected() });
    }
    if (m.type === 'output' && m.host === state.host && m.session === state.session) term.write(m.data);
    if (m.type === 'pairing' && m.host === state.host) {
      $('wg-qr').replaceChildren(); $('url-qr').replaceChildren();
      $('pairing').hidden = false;
      if (m.wg) drawQR($('wg-qr'), m.wg);
      else $('wg-qr').textContent = 'WireGuard 設定なし（ホスト側で TELEPORTER_WG_CLIENT_CONFIG を設定してください）';
      drawQR($('url-qr'), m.url);
    }
    if (m.type === 'delivery_error') { const entry = document.createElement('div'); entry.textContent = `${m.target}: ${m.error}`; $('log').prepend(entry); }
    if (m.type === 'message' && m.host === state.host && m.session === state.session) {
      const entry = document.createElement('div'); entry.textContent = `[${m.session}] ${m.from}: ${m.text}`; $('log').prepend(entry);
      while ($('log').children.length > 100) $('log').lastChild.remove();
    }
  };
  ws.onclose = e => { if (state.ws !== ws) return; state.ready = false; $('status').textContent = `Disconnected (${e.code})`; $('login').hidden = false;
    // Bad token is never retried automatically.
    if (e.code !== 1008 && e.code !== 1009) state.retry = setTimeout(connect, 3000);
  };
}
function drawQR(container, data) {
  const canvas = document.createElement('canvas'); container.append(canvas);
  QRCode.toCanvas(canvas, data, { errorCorrectionLevel: 'L', margin: 2, width: 300 }, error => {
    if (error) container.textContent = `QR generation failed: ${error.message}`;
  });
}
$('connect').onclick = () => { if ($('token').value) connect(); };
$('pair').onclick = () => { if (state.host) emit({ type: 'pair', host: state.host }); };
$('close-pair').onclick = () => { $('pairing').hidden = true; $('wg-qr').replaceChildren(); $('url-qr').replaceChildren(); };
// QR pairing secret lives only in the fragment (never sent to the HTTP server).
const pairing = new URLSearchParams(location.hash.slice(1)).get('token');
if (pairing) { $('token').value = pairing; history.replaceState(null, '', location.pathname + location.search); connect(); }
$('host').onchange = () => { state.host = $('host').value; state.session = ''; render(); };
$('session').onchange = () => { state.session = $('session').value; state.watchKey = ''; term.clear(); emit({ type: 'watch', ...selected() }); resize(); term.focus(); };
$('create').onclick = () => { if (!state.host) return; const session = Array.from(crypto.getRandomValues(new Uint8Array(4)), n => n.toString(16).padStart(2, '0')).join(''); emit({ type: 'create', host: state.host, session, harness: $('harness').value }); };
$('send').onclick = () => { const text = $('message').value.trim(); if (!text || !state.session || !$('target').value) return;
  const [toHost, to] = $('target').value.split('/');
  emit({ type: 'send', ...selected(), toHost, to, text }); $('message').value = ''; };
$('message').onkeydown = e => { if (e.key === 'Enter') $('send').click(); };
term.onData(data => { if (state.session) emit({ type: 'input', ...selected(), data }); });
for (const button of document.querySelectorAll('[data-key]')) button.onclick = () => { emit({ type: 'input', ...selected(), data: button.dataset.key }); term.focus(); };
new ResizeObserver(() => { fit.fit(); resize(); }).observe($('terminal'));
