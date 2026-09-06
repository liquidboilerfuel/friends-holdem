// サーバーの結合スモークテスト。2クライアントが参加→ハンド進行→決着まで通るか確認。
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3000;
const URL = `ws://localhost:${PORT}`;

function client(id, name, room) {
  const ws = new WebSocket(URL);
  const c = { ws, id, name, pub: null, priv: null, ready: false };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', id, name, room })));
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type === 'joined') c.ready = true;
    if (m.type === 'state') { c.pub = m.pub; c.priv = m.priv; }
    if (m.type === 'error') c.lastError = m.error;
  });
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function send(c, o) { c.ws.send(JSON.stringify(o)); }

let fail = 0;
function assert(cond, msg) { if (!cond) { fail++; console.error('FAIL:', msg); } else console.log('ok:', msg); }

async function main() {
  const a = client('A', 'アリス', 'TEST');
  const b = client('B', 'ボブ', 'TEST');
  await wait(400);
  assert(a.ready && b.ready, '2人参加できた');
  assert(a.pub && a.pub.seats.filter(Boolean).length === 2, '卓に2人着席');
  assert(a.pub.canStart, '開始可能');

  send(a, { type: 'start' });
  await wait(300);
  assert(a.pub.phase === 'preflop', 'プリフロップ開始');
  assert(a.priv.hole.length === 2, '自分の手札が2枚届く');
  // 相手の手札は見えない（公開状態にholeが無い）
  assert(a.pub.seats.every(s => !s || s.hole === undefined), '他人の手札は公開されない');

  // 決着までオートプレイ（コール/チェックのみ）。ため（ストリート遅延）はサーバーが自動解決するので待つ。
  let guard = 0;
  while ((a.pub.phase !== 'handover') && guard < 160) {
    guard++;
    for (const c of [a, b]) {
      if (c.priv && c.priv.isTurn) {
        if (c.priv.toCall > 0) send(c, { type: 'action', action: 'call' });
        else send(c, { type: 'action', action: 'check' });
        await wait(120);
      }
    }
    await wait(60);
  }
  assert(a.pub.phase === 'handover', `決着まで到達 (phase=${a.pub.phase})`);
  assert(a.pub.lastResult && a.pub.lastResult.pots.length >= 1, '結果にポットあり');
  const total = a.pub.seats.filter(Boolean).reduce((s,p)=>s+p.chips,0);
  assert(total === 8000, `チップ総量保存 (=${total})`);

  // レイズ→フォールドの検証
  await wait(300); // 自動次ハンドが走る可能性
  if (a.pub.phase === 'handover') { send(a, { type:'start' }); await wait(200); }
  // 手番の人がレイズ、相手フォールド
  guard = 0;
  let didRaise = false;
  while (a.pub.phase === 'preflop' && guard < 20) {
    guard++;
    for (const c of [a, b]) {
      if (c.priv && c.priv.isTurn) {
        if (!didRaise) { send(c, { type:'action', action:'raise', amount: c.priv.minRaiseTo }); didRaise = true; }
        else { send(c, { type:'action', action:'fold' }); }
        await wait(150);
      }
    }
    await wait(50);
  }
  assert(didRaise, 'レイズが通った');
  assert(a.pub.phase === 'handover', 'フォールドで決着');

  a.ws.close(); b.ws.close();
  console.log(`\nスモークテスト: ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
