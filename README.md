# Agent Teleporter

Pi / Claude Code を Web・Android から操作するセルフホスト型ターミナル。ローカルホストが PTY を実行し、Cloudflare Worker が複数ホスト・複数端末を中継します。Android は PWA または `android/` のアプリを利用できます。

## 起動

Node.js 20+、Cloudflare アカウント、ホスト側の `pi` / `claude` が必要です。

```sh
npm ci
npm run deploy
export TELEPORTER_TOKEN="$(openssl rand -hex 32)"
printf %s "$TELEPORTER_TOKEN" | npx wrangler secret put REMOTE_TOKEN --config worker/wrangler.jsonc

TELEPORTER_URL=wss://agent-teleporter.<account>.workers.dev/ws \
TELEPORTER_HOST_ID=laptop TELEPORTER_CWD="$HOME/Work/project" npm run host
```

公開 URL を開き、トークンを入力します。別ホストも同じ Worker とトークンに接続し、**ホストごとに異なる `TELEPORTER_HOST_ID`** を指定してください。画面でホスト・セッションを選択できます。

## WireGuard / QR（任意）

ホストに `wg`・`wg-quick`・`qrencode` をインストールし、UDP 51820 を到達可能にします。

```sh
node host/src/cli.js wg-init vpn.example.org:51820 "$HOME/.config/agent-teleporter-wg"
sudo wg-quick up "$HOME/.config/agent-teleporter-wg/wg-teleporter.conf"
TELEPORTER_BIND=10.77.0.1 TELEPORTER_TOKEN="$TELEPORTER_TOKEN" npm run host
```

Worker と WireGuard を併用する場合は `TELEPORTER_URL` と `TELEPORTER_BIND` を両方指定します。Web UI の **Pair Android** で QR を表示するには、ホスト起動時に `TELEPORTER_WG_CLIENT_CONFIG="$HOME/.config/agent-teleporter-wg/android.conf"` も設定してください。WireGuard 設定 QR は WireGuard アプリ、接続 QR は Android アプリの **Scan connection QR** で読み取ります。QR には秘密鍵または操作トークンが含まれます。

## エージェント間通信

Web UI から別ホストのセッションにも送信できます。エージェントから送る場合は、ホストで `npm link` してから:

```sh
teleporter send <宛先セッションID> "message"
teleporter send <ホストID>/<宛先セッションID> "message"
```

Pi は受信時に follow-up を実行します。Claude Code は次のユーザー入力時に受信内容を読み込みます。オフライン宛の永続キューはありません。

## 注意

共有トークンを持つ端末は全ホストを操作できます。同じ PTY への同時入力に排他制御はありません。Google アカウント同期は未実装です。

`npm test` でテストを実行できます。ライセンス: [MIT](LICENSE)。
