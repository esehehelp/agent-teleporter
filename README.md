# Agent Teleporter

Pi / Claude Code を外出先から操作するセルフホスト型ターミナル。ローカル Node.js ホストが PTY を所有し、Cloudflare Worker + Durable Object が WebSocket を中継します。Web ブラウザ、Android Chrome のインストール可能な PWA、または `android/` の WebView アプリから同じ UI を利用できます。Worker 側ではコマンドを実行しません。

## セットアップ

必要: Node.js 20+、`pi` / `claude`（使うものをホストの PATH に）、Cloudflare アカウント。ホストは外向きの WSS 接続だけを使います。

```sh
npm ci
# 開発時のみ: worker/.dev.vars に REMOTE_TOKEN=<長い乱数> を記載
npm run dev:worker
# 本番: secret を登録し Worker を公開
npx wrangler secret put REMOTE_TOKEN --config worker/wrangler.jsonc
npm run deploy
# 別ターミナル、または別マシンでローカルホストを起動
TELEPORTER_URL=wss://agent-teleporter.<account>.workers.dev/ws \
TELEPORTER_TOKEN='<同じ乱数>' TELEPORTER_HOST_ID=laptop \
TELEPORTER_CWD="$HOME/Work/project" npm run host
```

公開 URL をブラウザ / Android Chrome で開き、トークンを入力して Connect → New session。Android Chrome のメニューから「ホーム画面に追加」で PWA として起動できます。ネイティブ Android クライアントも `android/` にあります（Android Studio で開く。Google Play services Code Scanner を使った **Scan connection QR** ボタンを搭載。先に WireGuard アプリで VPN 設定 QR を読み込み、トンネルを ON にしてください）。トークンはページメモリだけに保持され、再読込時に再入力が必要です。複数ホストはそれぞれ同じ Worker URL / トークンに接続し、**異なる `TELEPORTER_HOST_ID`** を指定します（未指定ならホスト名を使用）。画面上のホスト一覧から切り替えられます。各ホストで複数セッションを作成してターミナル切り替え、リサイズ、キー操作が可能です。各 viewer は現在選択している `host/session` の出力だけを購読します。再接続後は直近 32 Ki 文字の PTY 出力を再表示します。

### WireGuard + QR（Worker 不要の直接接続）

ホストで `wg`, `wg-quick`, `qrencode` をインストールし、**公開 UDP 51820** をホストへ転送（またはホストがグローバル IP を所有）してください。ホストと Android の鍵・設定を生成します。出力ディレクトリは新規でなければならず、秘密鍵の権限は 0600 です。

```sh
node host/src/cli.js wg-init vpn.example.org:51820 "$HOME/.config/agent-teleporter-wg"
# 表示された最初の QR を Android の WireGuard アプリで「QR コードから作成」してトンネルを ON
sudo wg-quick up "$HOME/.config/agent-teleporter-wg/wg-teleporter.conf"
# 別ターミナル: WireGuard IP だけに HTTP/WS をバインド（公開 NIC は拒否）
TELEPORTER_BIND=10.77.0.1 TELEPORTER_TOKEN='<長い乱数>' TELEPORTER_CWD="$HOME/Work/project" npm run host
# 別ターミナル: Android ブラウザのカメラで URL QR をスキャン
TELEPORTER_TOKEN='<同じ乱数>' node host/src/cli.js qr http://10.77.0.1:8787/
```

Android が WireGuard に接続済みなら `http://10.77.0.1:8787/` を開けます。二つ目の QR は URL の **fragment** にトークンを入れ（HTTP リクエストには送られません）、表示後ブラウザの履歴から削除します。Web UI にログイン後、**Pair Android** を押して両方の QR を画面表示することもできます。WireGuard 設定 QR を有効化するにはホスト起動時に `TELEPORTER_WG_CLIENT_CONFIG="$HOME/.config/agent-teleporter-wg/android.conf"` を追加してください。これを有効化すると共有トークンで認証したブラウザにクライアントの VPN 秘密鍵を渡せるため、信頼できる利用者だけにトークンを配布してください。**QR を撮影・共有すると VPN の秘密鍵または操作権限が漏れます。** ネイティブ `android/` アプリにもこの HTTP URL を入力できます。ローカル専用経路は WireGuard の暗号化を前提とし、WireGuard インターフェースのプライベート IPv4 にしか bind しません。Worker 経由との同時利用も可能です（`TELEPORTER_URL` と `TELEPORTER_BIND` を両方設定）。

疎通確認: Android で WireGuard の handshake を確認し、VPN 上でページを開いて Connect / New session。サーバーでは `sudo wg show`、クライアント側で `10.77.0.1` に接続できることを確認。必要な受信ポートは VPN 用 UDP 51820 のみで、TCP 8787 は公開インターフェースで listen しません。ホストの firewall で WireGuard インターフェースからの TCP 8787 を許可してください。

### ハーネス間メッセージ

同一ホスト内・異なるホスト間のセッションへ、Web UI の送信欄からメッセージを送れます。エージェントからは実行環境内で以下を実行します（`TELEPORTER_SESSION` と `TELEPORTER_SOCKET` は自動設定）。

```sh
./host/src/cli.js send <同一ホストのセッションID> "レビューしてください"
./host/src/cli.js send <別ホストID>/<宛先セッションID> "レビューしてください"
./host/src/cli.js inbox
./host/src/cli.js subscribe
```

`npm link` 済みなら `teleporter send ...` を使用できます。Web UI も任意のホストのセッションへ送信できます。別ホスト宛は Worker がルーティングし、宛先がオフラインなら送信元に非同期のエラーを返します（永続キューなし）。ホストと Worker の接続が切れている場合は送信できません。Pi には起動時に同梱 extension を読み込み、Unix socket 購読で受信直後に follow-up メッセージとして届けます。Claude Code には `UserPromptSubmit` hook を自動設定し、次のユーザー入力時に未読メッセージをコンテキストに渡します。Web UI への通知は即時です。**Claude Code の実行中エージェントへ安全に割り込む API は使っていないため、Claude へのモデル入力は次回プロンプト時**です。未読はホストのメモリ（各セッション最大100件）にあり、ホスト終了時に失われます。

## セキュリティと制約

- Worker secret は十分長い乱数に設定。Cloudflare 経路は TLS (`wss://`) 必須（`localhost` の開発時のみ `ws://` 可）。WireGuard 直接経路は VPN 内 HTTP/WS です。共有トークンを知る人は全セッションの表示・操作が可能です。トークンを URL に含めません。必要に応じ Cloudflare Access 等の追加保護を設定してください。
- ユーザーが Worker に送信するのはホスト ID、定義済みのハーネス名、PTY キー入力のみ。任意のプログラムや作業ディレクトリの指定 API はありません。**セッションで動くエージェント自体はホストユーザーの権限で動作し、ファイル変更やコマンド実行が可能**です。リモート操作は信頼できる人だけに許可してください。
- ローカル Unix socket はユーザー専用ディレクトリに置き、0600 に設定。セッション履歴は Pi / Claude Code 自身の保存機能に依存します。Worker は履歴・秘密を永続化しません。オフライン時の PTY 出力は再接続後に最後の32 Ki文字だけ復元されます。
- 複数の操作端末が同一 PTY に同時入力できます。排他ロックはありません。ホストが同時接続する場合、ホスト ID はユニークにしてください。同一 ID の再接続は旧接続を置き換えます。共有トークンなのでホスト別・閲覧者別のアクセス制御はまだありません。Worker はデプロイ単位で単一 Durable Object にルーティングされ、大規模マルチテナントには別設計が必要です。画像、ファイル転送、OS 通知、バックグラウンド push（FCM 等）は対象外です。

## 開発

```sh
npm test
npm run build
```

Google アカウント同期は未実装です。MCP は構築時の操作ツールであり、実行時のログイン／同期には使いません。実装には Google OAuth Client ID と同期対象（設定のみ、またはセッション履歴など）の決定が必要です。この環境では Cloudflare / Google MCP ツールは提供されていませんが、Wrangler CLI による Cloudflare Worker の公開・secret 設定は可能です。

`ref/` は既存実装がないことの記録です。Wire protocol: 最初の JSON frame は `{type:"auth",role:"host"|"viewer",id,token}`。以降 viewer は `watch/create/input/resize/replay/send/pair`、host は `sessions/output/replay_output/message/forward/pairing` を送信します。`watch` が出力の購読先を切り替え、再生データも要求した viewer のみに届けます。`forward` は別ホストのセッションへ push します。認証、ID・サイズの検証と宛先ルーティングは Durable Object で行います。
