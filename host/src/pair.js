import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { privateBind } from './direct.js';

const wg = (...args) => execFileSync('wg', args, { encoding: 'utf8' }).trim();
const pub = key => execFileSync('wg', ['pubkey'], { input: key + '\n', encoding: 'utf8' }).trim();
export function qr(value) {
  // QR may contain a VPN private key or the remote control token: do not log elsewhere.
  process.stdout.write(execFileSync('qrencode', ['-t', 'ANSIUTF8', '-o', '-'], { input: value, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
}
export function wgInit(endpoint, directory) {
  if (!/^[a-zA-Z0-9.:-]+:[0-9]{1,5}$/.test(endpoint) || !directory) throw new Error('Usage: teleporter wg-init <public-host:51820> <new-private-directory>');
  const port = Number(endpoint.slice(endpoint.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new Error('Invalid WireGuard UDP port');
  // Reject pre-existing destination rather than overwriting a key or following a symlink.
  fs.mkdirSync(directory, { mode: 0o700 });
  const serverKey = wg('genkey'), clientKey = wg('genkey');
  const server = `[Interface]\nAddress = 10.77.0.1/24\nListenPort = ${port}\nPrivateKey = ${serverKey}\n\n[Peer]\nPublicKey = ${pub(clientKey)}\nAllowedIPs = 10.77.0.2/32\n`;
  const client = `[Interface]\nAddress = 10.77.0.2/32\nPrivateKey = ${clientKey}\n\n[Peer]\nPublicKey = ${pub(serverKey)}\nEndpoint = ${endpoint}\nAllowedIPs = 10.77.0.0/24\nPersistentKeepalive = 25\n`;
  const serverFile = path.join(directory, 'wg-teleporter.conf');
  const clientFile = path.join(directory, 'android.conf');
  fs.writeFileSync(serverFile, server, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(clientFile, client, { mode: 0o600, flag: 'wx' });
  console.log(`Server: ${serverFile}\nAndroid: ${clientFile}\nScan with WireGuard Android app (contains private key):`);
  qr(client);
}
export function pairUrl(url, token) {
  const parsed = new URL(url);
  if (!token || !['http:', 'https:'].includes(parsed.protocol) ||
      (parsed.protocol === 'http:' && !privateBind(parsed.hostname)))
    throw new Error('Set TELEPORTER_TOKEN; URL must be HTTPS or a private WireGuard IPv4 HTTP address');
  parsed.hash = `token=${encodeURIComponent(token)}`;
  console.log('Scan URL QR in Android browser (contains remote control token):');
  qr(parsed.toString());
}
