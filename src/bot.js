// CPUの思考ロジック。強すぎず弱すぎない、内輪で遊べる程度のヒューリスティック。
import { evaluateBest } from './handEval.js';

// プリフロップの手札強度 0..1（簡易Chenフォーミュラを正規化）
function preflopStrength(hole) {
  let [a, b] = hole.map((c) => c.r).sort((x, y) => y - x);
  const suited = hole[0].s === hole[1].s;
  const hi = a;
  let score;
  const base = (r) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  if (a === b) {
    score = Math.max(base(a) * 2, 5);           // ペア
  } else {
    score = base(hi);
    if (suited) score += 2;
    const gap = a - b - 1;
    score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && a < 12) score += 1;         // コネクター補正
  }
  return Math.max(0, Math.min(1, score / 20));
}

// ボードとの組み合わせで役＋ドローを見た強度 0..1
function postflopStrength(hole, community) {
  const cards = [...hole, ...community];
  const cat = evaluateBest(cards).category;
  const catStrength = [0.16, 0.42, 0.66, 0.80, 0.90, 0.93, 0.96, 0.99, 1][cat];

  // ドロー検出（フラッシュ4枚 / オープンエンド）
  let draw = 0;
  const suitCount = {};
  for (const c of cards) suitCount[c.s] = (suitCount[c.s] || 0) + 1;
  if (Object.values(suitCount).some((n) => n === 4)) draw = Math.max(draw, 0.18);
  const rset = [...new Set(cards.map((c) => c.r))].sort((x, y) => x - y);
  for (let i = 0; i + 3 < rset.length; i++) {
    if (rset[i + 3] - rset[i] === 3) draw = Math.max(draw, 0.14); // 4連続=ストレートドロー
  }
  return Math.min(1, catStrength + (cat <= 1 ? draw : 0));
}

// table と席番号から合法な行動を返す { action, amount }
export function decideBotAction(table, seat) {
  const p = table.seats[seat];
  const priv = table.getPrivateState(p.id);
  const toCall = priv.toCall;
  const canRaise = priv.maxBetTo > table.currentBet;
  const pot = Math.max(table.bigBlind, table.pot);
  const noise = (Math.random() - 0.5) * 0.12;

  let strength = (table.community.length === 0)
    ? preflopStrength(p.hole)
    : postflopStrength(p.hole, table.community);
  strength = Math.max(0, Math.min(1, strength + noise));

  // レイズ目標額を作る（ポットのfraction、最低レイズ〜オールインにクランプ）
  const raiseTo = (frac) => {
    const add = Math.max(table.minRaise, Math.round(pot * frac));
    let t = table.currentBet + add;
    t = Math.max(priv.minRaiseTo, Math.min(priv.maxBetTo, t));
    return t;
  };

  if (toCall <= 0) {
    // チェック可能
    if (canRaise && strength > 0.7) return { action: 'raise', amount: raiseTo(0.66) };
    if (canRaise && strength > 0.45 && Math.random() < 0.35) return { action: 'raise', amount: raiseTo(0.5) };
    if (canRaise && strength < 0.2 && Math.random() < 0.12) return { action: 'raise', amount: raiseTo(0.5) }; // たまにブラフ
    return { action: 'check' };
  }

  // コールに直面
  const potOdds = toCall / (pot + toCall);
  if (canRaise && strength > 0.82 && Math.random() < 0.6) return { action: 'raise', amount: raiseTo(0.75) };
  if (strength >= 0.5) {
    // 強め：オーバーベットでなければコール
    if (toCall <= pot * 1.2) return { action: 'call' };
    return strength > 0.85 ? { action: 'call' } : { action: 'fold' };
  }
  if (strength >= potOdds + 0.08) return { action: 'call' }; // オッズが合えばコール
  if (toCall <= table.bigBlind && Math.random() < 0.3) return { action: 'call' }; // 安ければ様子見
  return { action: 'fold' };
}
