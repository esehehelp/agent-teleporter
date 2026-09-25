import net from 'node:net';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Load with `pi -e /path/to/pi-messages.ts`. Incoming messages are follow-ups,
// never raw terminal keystrokes (which could corrupt a running tool or approval).
export default function (pi: ExtensionAPI) {
  let socket: net.Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  const seen = new Set<string>();
  function connect() {
    if (!active || !process.env.TELEPORTER_SOCKET || !process.env.TELEPORTER_SESSION) return;
    socket = net.connect(process.env.TELEPORTER_SOCKET);
    let buffer = '';
    socket.on('connect', () => socket?.write(JSON.stringify({ action: 'subscribe', session: process.env.TELEPORTER_SESSION }) + '\n'));
    socket.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 16384) { buffer = ''; return; }
      let pos;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'message' && typeof msg.id === 'string' && !seen.has(msg.id)) {
            seen.add(msg.id);
            if (seen.size > 200) seen.delete(seen.values().next().value!);
            pi.sendUserMessage(`[Message from ${msg.from} via teleporter]\n${msg.text}`, { deliverAs: 'followUp' });
          }
        } catch { /* ignore malformed records */ }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (active) retry = setTimeout(connect, 1500); });
  }
  pi.on('session_start', () => { active = true; connect(); });
  pi.on('session_shutdown', () => { active = false; clearTimeout(retry); socket?.destroy(); });
}
