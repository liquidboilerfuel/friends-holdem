// テキサスホールデムのハンド評価。
// カードは { r: 2..14, s: 0..3 } （14=A, 13=K, 12=Q, 11=J）。
// evaluateBest(cards7) は最強5枚のスコアを返す。
// スコアは配列 [category, tiebreak...]。数値配列として辞書順で大きい方が強い。
// category: 8=ストレートフラッシュ 7=フォーカード 6=フルハウス 5=フラッシュ
//           4=ストレート 3=スリーカード 2=ツーペア 1=ワンペア 0=ハイカード

export const RANK_NAMES = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};
export const SUIT_NAMES = ['s', 'h', 'd', 'c']; // spade, heart, diamond, club
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
export const CATEGORY_NAMES = [
  'ハイカード', 'ワンペア', 'ツーペア', 'スリーカード',
  'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
];

export function makeDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) deck.push({ r, s });
  }
  return deck;
}

export function shuffle(deck, rng = Math.random) {
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function cardToStr(c) {
  return RANK_NAMES[c.r] + SUIT_NAMES[c.s];
}

// 5枚を評価
function evaluate5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a); // 降順
  const suits = cards.map((c) => c.s);
  const isFlush = suits.every((s) => s === suits[0]);

  // ストレート判定（Aは 14 と 1 の両方を試す）
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    // A-2-3-4-5 (wheel): 14,5,4,3,2
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }

  // ランクごとの枚数
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // [count, rank] を count 降順→rank 降順で並べる
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, Number(r)])
    .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
  const pattern = groups.map((g) => g[0]).join(''); // 例: "41","32","311","221","2111","11111"
  const byGroup = groups.map((g) => g[1]); // count順に並んだランク

  if (isFlush && straightHigh) return [8, straightHigh];
  if (pattern === '41') return [7, byGroup[0], byGroup[1]];
  if (pattern === '32') return [6, byGroup[0], byGroup[1]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (pattern === '311') return [3, byGroup[0], byGroup[1], byGroup[2]];
  if (pattern === '221') return [2, byGroup[0], byGroup[1], byGroup[2]];
  if (pattern === '2111') return [1, byGroup[0], byGroup[1], byGroup[2], byGroup[3]];
  return [0, ...ranks];
}

export function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 5〜7枚から最強5枚のスコアと使用カードを返す
export function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('need at least 5 cards');
  let best = null;
  let bestCards = null;
  const n = cards.length;
  // C(n,5) 全列挙
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate5(combo);
            if (best === null || compareScore(score, best) > 0) {
              best = score;
              bestCards = combo;
            }
          }
  return { score: best, cards: bestCards, category: best[0], categoryName: CATEGORY_NAMES[best[0]] };
}

export { evaluate5 };
