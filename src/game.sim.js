// エンジンの結合シミュレーション。実際の対戦をランダム行動で多数回まわし、
// 不変条件（チップ総量保存・ポット非負・手番の整合）を検証する。
import { Table, MAX_SEATS } from './game.js';

function totalChips(t) {
  return t.seats.filter(Boolean).reduce((s, p) => s + p.chips, 0) + t.pot;
}

let fail = 0;
function assert(cond, msg) { if (!cond) { fail++; console.error('ASSERT FAIL:', msg); } }

function playRandomHand(t, rng) {
  const start = t.startHand();
  if (!start.ok) return false;
  const initialTotal = totalChips(t);
  let guard = 0;
  while (t.phase !== 'handover' && t.phase !== 'waiting') {
    guard++;
    if (guard > 500) { assert(false, '無限ループの疑い'); break; }
    // ため（遅延解決）はテストでは即座に解決する
    if (t.pending) { t.resolvePending(); continue; }
    const seat = t.turn;
    assert(seat >= 0, `handover前なのに手番なし phase=${t.phase}`);
    const p = t.seats[seat];
    assert(p && !p.folded && !p.allIn, `手番が不正 seat=${seat}`);
    const priv = t.getPrivateState(p.id);
    const r = rng();
    let res;
    if (priv.toCall > 0 && r < 0.15) {
      res = t.act(p.id, 'fold');
    } else if (r < 0.6) {
      res = priv.toCall > 0 ? t.act(p.id, 'call') : t.act(p.id, 'check');
    } else {
      // レイズを試す。無理ならコール/チェックにフォールバック
      const to = Math.min(priv.maxBetTo, priv.minRaiseTo + Math.floor(rng() * 100));
      res = t.act(p.id, 'raise', to);
      if (!res.ok) res = priv.toCall > 0 ? t.act(p.id, 'call') : t.act(p.id, 'check');
    }
    assert(res.ok, `アクション失敗: ${res.error}`);
    assert(t.pot >= 0, 'ポットが負');
  }
  assert(totalChips(t) === initialTotal, `チップ保存崩れ: ${initialTotal} -> ${totalChips(t)}`);
  return true;
}

// 疑似乱数（再現性のため）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runGame(nPlayers, seed) {
  const rng = mulberry32(seed);
  const t = new Table({ smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  const ids = [];
  for (let i = 0; i < nPlayers; i++) {
    const id = 'p' + i;
    const res = t.addPlayer(id, 'P' + i);
    assert(res.ok, `追加失敗 ${id}`);
    ids.push(id);
  }
  const grandTotal = 1000 * nPlayers;
  let hands = 0;
  while (t.canStart() && hands < 300) {
    playRandomHand(t, rng);
    assert(totalChips(t) === grandTotal, `ゲーム通算のチップ保存崩れ hand=${hands}`);
    hands++;
  }
  return hands;
}

let totalHands = 0;
for (let n = 2; n <= 6; n++) {
  for (let seed = 1; seed <= 40; seed++) {
    totalHands += runGame(n, seed * 100 + n);
  }
}

console.log(`シミュレーション完了: ${totalHands} ハンド実行, ${fail} 失敗`);
process.exit(fail ? 1 : 0);
