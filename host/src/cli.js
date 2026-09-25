#!/usr/bin/env node
import net from 'node:net';
import { Host } from './host.js';
import { wgInit, pairUrl } from './pair.js';

const [action, ...args] = process.argv.slice(2);
if (action === 'wg-init') {
  wgInit(args[0], args[1]);
} else if (action === 'qr') {
  pairUrl(args[0], process.env.TELEPORTER_TOKEN);
} else if (action === 'serve') {
  const host = new Host({ url: process.env.TELEPORTER_URL, token: process.env.TELEPORTER_TOKEN,
    id: process.env.TELEPORTER_HOST_ID, cwd: process.env.TELEPORTER_CWD || process.cwd(),
    bind: process.env.TELEPORTER_BIND, port: Number(process.env.TELEPORTER_PORT || 8787),
    socketPath: process.env.TELEPORTER_SOCKET });
  host.start();
  console.log(`Host ${host.id} in ${host.cwd}; local socket ${host.socketPath}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { host.stop(); process.exit(0); });
} else if (['send', 'inbox', 'subscribe'].includes(action)) {
  const session = process.env.TELEPORTER_SESSION || args.shift();
  const socketPath = process.env.TELEPORTER_SOCKET;
  if (!session || !socketPath) { console.error('Set TELEPORTER_SOCKET and TELEPORTER_SESSION (or pass session as first argument)'); process.exit(1); }
  const request = action === 'send' ? { action, session, to: args.shift(), text: args.join(' ') } : { action, session };
  const sock = net.connect(socketPath);
  sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
  sock.on('data', chunk => process.stdout.write(chunk));
  sock.on('error', e => { console.error(e.message); process.exitCode = 1; });
} else {
  console.error('Usage: teleporter serve | wg-init <public-endpoint:port> <new-dir> | qr <url> | send [session] <target> <text> | inbox [session] | subscribe [session]');
  process.exit(1);
}
