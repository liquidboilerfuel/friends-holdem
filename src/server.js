// WebSocketサーバー（権威）。各プレイヤーには自分の手札のみを配信する。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Table } from './game.js';
import { decideBotAction } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const AUTO_NEXT_HAND_MS = 6000;      // ショーダウン後、次ハンド自動開始まで
const DISCONNECT_ACT_MS = 12000;     // 切断者の手番を自動処理するまで
const STREET_PAUSE_MS = 1200;        // ベッティングラウンド完了→次のカードを開くまでの「ため」

// ---- 静的ファイル ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- ルーム管理 ----
const rooms = new Map(); // code -> { table, clients: Set<ws>, autoTimer, actTimer }

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { table: new Table(), clients: new Set(), autoTimer: null, actTimer: null, botTimer: null, pendingTimer: null };
    rooms.set(code, room);
  }
  return room;
}

function broadcast(room) {
  const pub = room.table.getPublicState();
  for (const ws of room.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const priv = ws.playerId ? room.table.getPrivateState(ws.playerId) : null;
    ws.send(JSON.stringify({ type: 'state', pub, priv }));
  }
  scheduleTimers(room);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function clearRoomTimers(room) {
  for (const k of ['autoTimer', 'botTimer', 'actTimer', 'pendingTimer']) {
    if (room[k]) { clearTimeout(room[k]); room[k] = null; }
  }
}

function autoActFor(room, seat, useBot) {
  const t = room.table;
  const p = t.seats[seat];
  if (!p || t.turn !== seat || p.folded || p.allIn) return;
  if (useBot) {
    let d; try { d = decideBotAction(t, seat); } catch { d = { action: 'check' }; }
    let res = t.act(p.id, d.action, d.amount);
    if (!res.ok) { res = t.act(p.id, 'check'); if (!res.ok) t.act(p.id, 'fold'); }
  } else {
    const priv = t.getPrivateState(p.id);
    if (priv && priv.toCall > 0) t.act(p.id, 'fold');
    else t.act(p.id, 'check');
  }
  broadcast(room);
}

// 進行のペース制御：ため（ストリート遅延）・次ハンド自動開始・CPU/AI代行・時間切れ
function scheduleTimers(room) {
  const t = room.table;
  clearRoomTimers(room);

  // 「ため」：ベッティングラウンド完了後、少し置いてから次のカードを開く
  if (t.pending) {
    room.pendingTimer = setTimeout(() => {
      room.pendingTimer = null;
      if (t.pending) { t.resolvePending(); broadcast(room); }
    }, STREET_PAUSE_MS);
    return; // ため中は他のタイマーを走らせない
  }

  // 次ハンド自動開始（autoNextHandがONのときだけ。既定は区切って「次のハンド」待ち）
  if (t.phase === 'handover') {
    if (t.autoNextHand && t.canStart()) {
      room.autoTimer = setTimeout(() => {
        room.autoTimer = null;
        if (t.canStart()) { t.startHand(); broadcast(room); }
      }, AUTO_NEXT_HAND_MS);
    }
    return;
  }

  if (t.turn < 0 || t.phase === 'waiting' || t.phase === 'handover') return;
  const p = t.seats[t.turn];
  if (!p) return;

  if (p.isBot || p.auto) {
    // CPU または AI代行ON の人間 → 少し考えてから自動で行動（ためを持たせる）
    const delay = 1100 + Math.floor(Math.random() * 1500);
    room.botTimer = setTimeout(() => { room.botTimer = null; autoActFor(room, p.seat, true); }, delay);
  } else if (!p.connected) {
    // 切断中 → 短めの猶予で自動チェック/フォールド
    room.actTimer = setTimeout(() => { room.actTimer = null; autoActFor(room, p.seat, false); }, DISCONNECT_ACT_MS);
  } else {
    // 接続中の人間 → 持ち時間切れで自動チェック/フォールド（クライアントは残り時間を表示）
    const remain = Math.max(500, (t.turnDeadline || 0) - Date.now());
    room.actTimer = setTimeout(() => { room.actTimer = null; autoActFor(room, p.seat, false); }, remain);
  }
}

// ---- WebSocket ----
const wss = new WebSocketServer({ server });

// ハートビート：プロキシ越しのアイドル切断を防ぎ、死んだ接続を掃除する
const HEARTBEAT_MS = 30000;
function heartbeat() { this.isAlive = true; }
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.clients.delete(ws);
    if (ws.playerId) room.table.setConnected(ws.playerId, false);
    // ルームが空なら掃除
    if (room.clients.size === 0) {
      clearRoomTimers(room);
      rooms.delete(ws.roomCode);
    } else {
      broadcast(room);
    }
  });
});

function handle(ws, msg) {
  if (msg.type === 'join') {
    const code = String(msg.room || '').trim().toUpperCase().slice(0, 12) || 'LOBBY';
    const name = String(msg.name || '名無し').trim().slice(0, 16) || '名無し';
    const avatar = String(msg.avatar || '🙂').slice(0, 4) || '🙂';
    const id = String(msg.id || '').slice(0, 64) || ('u' + Math.random().toString(36).slice(2, 10));

    const room = getRoom(code);
    ws.roomCode = code;
    ws.playerId = id;
    room.clients.add(ws);

    // 既存プレイヤーの再接続 or 新規着席
    const existing = room.table.seats.find((s) => s && s.id === id);
    if (existing) {
      existing.connected = true;
      existing.name = name;
      existing.avatar = avatar;
    } else {
      const res = room.table.addPlayer(id, name, avatar);
      if (!res.ok) { send(ws, { type: 'error', error: res.error }); }
    }
    send(ws, { type: 'joined', id, room: code });
    broadcast(room);
    return;
  }

  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) { send(ws, { type: 'error', error: '未参加です' }); return; }
  const t = room.table;

  if (msg.type === 'start') {
    const res = t.startHand();
    if (!res.ok) send(ws, { type: 'error', error: res.error });
    broadcast(room);
  } else if (msg.type === 'addBot') {
    const res = t.addBot();
    if (!res.ok) send(ws, { type: 'error', error: res.error });
    broadcast(room);
  } else if (msg.type === 'removeBot') {
    const res = t.removeBot();
    if (!res.ok) send(ws, { type: 'error', error: res.error });
    broadcast(room);
  } else if (msg.type === 'setAuto') {
    t.setAuto(ws.playerId, !!msg.on);
    broadcast(room);
  } else if (msg.type === 'setBlindConfig') {
    t.setBlindConfig({ mode: msg.mode, minutes: msg.minutes, hands: msg.hands });
    broadcast(room);
  } else if (msg.type === 'action') {
    const res = t.act(ws.playerId, msg.action, msg.amount);
    if (!res.ok) send(ws, { type: 'error', error: res.error });
    broadcast(room);
  } else if (msg.type === 'leave') {
    t.removePlayer(ws.playerId);
    ws.playerId = null;
    broadcast(room);
  } else if (msg.type === 'rebuy') {
    // キャッシュ方式のみ：チップ0の自分に補充（再バイイン）。トーナメントは不可。
    const p = t.seats.find((s) => s && s.id === ws.playerId);
    if (!t.tournament && p && p.chips <= 0 && (t.phase === 'waiting' || t.phase === 'handover' || p.sittingOut)) {
      p.chips = t.startingChips;
      p.sittingOut = false;
      t._log(`${p.name} がリバイ（${t.startingChips}）`);
    }
    broadcast(room);
  } else if (msg.type === 'newGame') {
    t.resetTournament();
    broadcast(room);
  } else if (msg.type === 'ping') {
    send(ws, { type: 'pong' });
  }
}

server.listen(PORT, () => {
  console.log(`ポーカーサーバー起動: http://localhost:${PORT}`);
});
