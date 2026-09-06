# 内輪ホールデム

友達内輪で遊ぶテキサスホールデム。Webアプリ（ブラウザ）+ WebSocketサーバーで動きます。
サーバーが状態を持ち、**各プレイヤーには自分の手札しか送らない**ので、通信を覗いても他人の手札は見えません。

## 遊び方（プレイヤー）

1. 共有されたURLを開く。
2. 名前と部屋コード（合言葉）を入れて「参加する」。
3. 同じ部屋コードの人と同卓します。2人以上チップがあれば「ハンド開始」。
4. 自分の手番になったら フォールド / チェック / コール / ベット・レイズ / オールイン。
5. 決着後は数秒で次のハンドが自動で始まります（手動でも開始可）。

チップが尽きたら「リバイ」で補充できます（精算なしのカジュアル用）。

## 起動（ホストする人）

Node.js 18 以上が必要です。

```bash
npm install
npm start
# → http://localhost:3000 で起動
```

同じ家のLAN内なら `http://<ホストのIP>:3000` で他の人も入れます。
外の友達と遊ぶなら、下の「公開する」を参照。

### 一時公開（すぐ試す）

[cloudflared](https://developers.cloudflare.com/cloudflare-tunnel/) や ngrok でトンネル：

```bash
npx cloudflared tunnel --url http://localhost:3000
# 表示された https URL を友達に共有
```

### 常設（無料クラウド：Render）

このリポジトリには `render.yaml`（Blueprint）を同梱しています。GitHub に push して Render につなぐだけで、常時アクセスできる URL が発行されます。

1. GitHub にリポジトリを作り、このフォルダを push する。
2. [Render](https://render.com) にサインアップ（GitHub 連携が簡単）。
3. New → Blueprint → 該当リポジトリを選ぶ（`render.yaml` を自動検出）。または New → Web Service で、Build: `npm install` / Start: `npm start`。
4. 数分でデプロイされ、`https://<名前>.onrender.com` の URL が出る。これを友達に共有。

補足：Render の無料プランは一定時間アクセスがないとスリープし、次のアクセスで復帰に数十秒かかります（起動中の対局状態はリセット）。カジュアル用途なら問題ありません。常時起動が必要なら有料プランへ。WebSocket は対応済み（プロキシ越しの切断対策のハートビートも実装済み）。

## ルール・仕様

- テキサスホールデム、2〜6人。
- 既定はトーナメント方式（チップ0で脱落・リバイなし・最後の1人で優勝）。
- ブラインドは既定で「5ハンドごと」に上昇（100/200 スタート）。設定で 時間／ハンド数／固定 に変更可。
- ベット・レイズは100刻み。初期チップ 4000。
- サイドポット、オールイン、ヘッズアップ（2人）、CPU対戦、AI代行に対応。
- 各種パラメータは `src/game.js` の `Table` 既定値で変更可。

## 構成

```
src/handEval.js   役の評価（7枚→最強5枚）
src/game.js       ゲーム進行エンジン（サーバー権威）
src/server.js     HTTP + WebSocket サーバー、ルーム管理、手札の個別配信
public/index.html クライアント（1ファイル、素のJS）
```

## テスト

```bash
node src/handEval.test.js   # 役評価のユニットテスト
node src/game.sim.js        # 6000ハンド規模のランダム対戦でチップ保存等を検証
```

## Discord で遊ぶ場合

このままWebアプリとして遊べますが、Discord内で起動したいなら
**Discord Activity（Embedded App SDK）** としてこのWebアプリを載せる形が使えます。
Discord Developer Portal でアプリを作り、Activity の URL Mapping にこのサーバーのURLを指定します。
その際は Discord の OAuth（参加者の識別）と、iframe 用の CSP 調整が追加で必要になります。
