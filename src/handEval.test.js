import { evaluateBest, compareScore, CATEGORY_NAMES } from './handEval.js';

// 文字列 "As Kd 5c" → カード配列
function parse(str) {
  const rankMap = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  const suitMap = { s: 0, h: 1, d: 2, c: 3 };
  return str.trim().split(/\s+/).map((t) => {
    const r = rankMap[t[0]] ?? Number(t[0]);
    return { r, s: suitMap[t[1]] };
  });
}

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.error(`FAIL: ${name} → got=${got} want=${want}`); }
}
function cmp(name, aStr, bStr, expectSign) {
  const a = evaluateBest(parse(aStr)).score;
  const b = evaluateBest(parse(bStr)).score;
  const s = Math.sign(compareScore(a, b));
  if (s === expectSign) { pass++; }
  else { fail++; console.error(`FAIL: ${name} → sign=${s} want=${expectSign} (a=${a} b=${b})`); }
}

// カテゴリ判定
eq('ロイヤル=SF', evaluateBest(parse('As Ks Qs Js Ts 2h 3d')).categoryName, CATEGORY_NAMES[8]);
eq('フォーカード', evaluateBest(parse('9s 9h 9d 9c Ks 2h 3d')).categoryName, CATEGORY_NAMES[7]);
eq('フルハウス', evaluateBest(parse('9s 9h 9d Kc Ks 2h 3d')).categoryName, CATEGORY_NAMES[6]);
eq('フラッシュ', evaluateBest(parse('2s 5s 9s Js Ks 2h 3d')).categoryName, CATEGORY_NAMES[5]);
eq('ストレート', evaluateBest(parse('5h 6d 7s 8c 9h Ac Kd')).categoryName, CATEGORY_NAMES[4]);
eq('ホイール(A2345)', evaluateBest(parse('Ah 2d 3s 4c 5h Kd Qc')).categoryName, CATEGORY_NAMES[4]);
eq('スリーカード', evaluateBest(parse('7h 7d 7s 2c 9h Kd Qc')).categoryName, CATEGORY_NAMES[3]);
eq('ツーペア', evaluateBest(parse('7h 7d 9s 9c 2h Kd Qc')).categoryName, CATEGORY_NAMES[2]);
eq('ワンペア', evaluateBest(parse('7h 7d 9s 4c 2h Kd Qc')).categoryName, CATEGORY_NAMES[1]);
eq('ハイカード', evaluateBest(parse('7h 2d 9s 4c Jh Kd Qc')).categoryName, CATEGORY_NAMES[0]);

// 比較
cmp('SF > フォーカード', 'As Ks Qs Js Ts', 'Ah Ad Ac As Kd', 1);
cmp('フルハウス > フラッシュ', '9s 9h 9d Kc Kd', '2s 5s 9s Js Ks', 1);
cmp('ストレート高い方勝ち', '6h 7d 8s 9c Th 2d 3c', '5h 6d 7s 8c 9h 2d 3c', 1);
cmp('ホイール < 通常最低ストレート', '2h 3d 4s 5c 6h', 'Ah 2d 3s 4c 5h', 1);
cmp('キッカー勝負', 'As Ah Kd Qc 9h 2s 3d', 'As Ah Kd Qc 8h 2s 3d', 1);
cmp('同ハンドは引き分け', 'As Ah Kd Qc 9h', 'Ac Ad Kh Qs 9c', 0);
cmp('フラッシュはランク比較', 'As Ks Qs 5s 2s', 'Ah Kh Qh 4h 3h', 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
