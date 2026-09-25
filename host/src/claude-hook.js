#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: stdout is added to the next prompt context.
import net from 'node:net';
const { TELEPORTER_SOCKET: socketPath, TELEPORTER_SESSION: session } = process.env;
if (!socketPath || !session) process.exit(0);
const sock = net.connect(socketPath);
let data = '';
sock.setTimeout(3000, () => sock.destroy());
sock.on('connect', () => sock.write(JSON.stringify({ action: 'drain', session }) + '\n'));
sock.on('data', chunk => { data += chunk; if (data.length > 500000) sock.destroy(); });
sock.on('end', () => {
  try {
    const messages = JSON.parse(data);
    if (messages.length) console.log('Messages from other agent sessions (via Agent Teleporter):\n' +
      messages.map(m => `[${m.from} -> ${m.to}]: ${m.text}`).join('\n'));
  } catch { /* do not interrupt Claude on local socket errors */ }
});
sock.on('error', () => {});
