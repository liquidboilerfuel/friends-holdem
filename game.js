// テキサスホールデムのゲームエンジン（サーバー権威）。
// 席は固定 MAX_SEATS。各席は null もしくはプレイヤーオブジェクト。
// UI/通信からは Table クラスを操作し、getPublicState / getHoleCards で状態を取得する。

import { makeDeck, shuffle, evaluateBest, compareScore, cardToStr } from './handEval.js';

export const MAX_SEATS = 6;

function emptyPlayer(id, name, chips, isBot = false, avatar = '🙂') {
  return {
    id,
    name,
    avatar,
    isBot,
    auto: false,   // 人間がAI代行をONにしているか
    eliminated: false, // トーナメントで脱落したか
    chips,
    seat: -1,
    hole: [],       // 手札（本人にのみ送る）
    bet: 0,         // 現ストリートの拠出
    committed: 0,   // このハンドでの総拠出（サイドポット計算用）
    folded: false,
    allIn: false,
    hasActed: false,
    connected: true,
    sittingOut: false, // チップ0などで次ハンド待機
    lastAction: null,  // 'fold'|'check'|'call'|'bet'|'raise'|'allin'
  };
}

export class Table {
  constructor(opts = {}) {
    this.seats = new Array(MAX_SEATS).fill(null);
    // ブラインド構成。[SB, BB] の配列で段階的に上昇。（100/200から、SBは100以上）
    this.blindLevels = opts.blindLevels ?? [
      [100, 200], [200, 400], [300, 600], [500, 1000], [700, 1400],
      [1000, 2000], [1500, 3000], [2000, 4000], [3000, 6000], [5000, 10000], [8000, 16000],
    ];
    this.betStep = opts.betStep ?? 100; // ベット/レイズの刻み
    this.autoNextHand = opts.autoNextHand ?? false; // 決着後に自動で次ハンドへ進むか（既定OFF＝区切る）
    this.tournament = opts.tournament ?? true;      // トーナメント方式（チップ0で脱落、リバイなし、最後の1人で優勝）
    this.champion = null;                            // 優勝者の席番号（決まったらセット）
    this.sbSeat = -1; this.bbSeat = -1;              // スモール/ビッグブラインドの席
    this.blindMode = opts.blindMode ?? 'hands';  // 'time'（時間で上昇）| 'hands'（ハンド数）| 'off'（固定）
    this.levelTime = opts.levelTime ?? 600000;   // timeモードの1レベルの長さ(ms)。既定10分
    this.levelHands = opts.levelHands ?? 5;       // handsモードの1レベルのハンド数。既定5
    this.blindLevel = 0;
    this.levelDeadline = 0;                       // timeモード：次に上がる時刻(epoch ms)
    this.handsThisLevel = 0;                      // handsモード：現レベルで消化したハンド数
    const lvl0 = this.blindMode !== 'off' ? this.blindLevels[0] : [opts.smallBlind ?? 5, opts.bigBlind ?? 10];
    this.smallBlind = lvl0[0];
    this.bigBlind = lvl0[1];
    this.startingChips = opts.startingChips ?? 4000;
    this.turnTime = opts.turnTime ?? 30000;   // 1手の持ち時間(ms)。時間切れで自動チェック/フォールド
    this.turnDeadline = 0;                     // 現手番の締切(epoch ms)。0=手番なし
    this.pending = false;                      // 次のストリート/ショーダウンを遅延解決するフラグ（ため用）
    this.button = -1;
    this.deck = [];
    this.community = [];
    this.pot = 0;                // 表示用の総ポット
    this.phase = 'waiting';      // waiting | preflop | flop | turn | river | handover
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.turn = -1;              // 手番の席番号
    this.handId = 0;
    this.lastResult = null;      // 直近ハンドの結果（handover 時）
    this.log = [];               // 直近のイベントログ（表示用）
  }

  // ---- 参加/離席 ----
  addPlayer(id, name, avatar) {
    const seat = this.seats.findIndex((s) => s === null);
    if (seat === -1) return { ok: false, error: '満席です' };
    if (this.seats.some((s) => s && s.id === id)) return { ok: false, error: '既に着席しています' };
    const p = emptyPlayer(id, name, this.startingChips, false, avatar || '🙂');
    p.seat = seat;
    // 進行中のハンドには途中参加させない
    if (this.phase !== 'waiting' && this.phase !== 'handover') p.sittingOut = true;
    this.seats[seat] = p;
    this._log(`${name} が席${seat + 1}に着席`);
    return { ok: true, seat };
  }

  addBot(name) {
    const seat = this.seats.findIndex((s) => s === null);
    if (seat === -1) return { ok: false, error: '満席です' };
    const n = this._occupied().filter((p) => p.isBot).length + 1;
    const id = 'bot_' + Math.random().toString(36).slice(2, 9);
    const p = emptyPlayer(id, name || ('CPU ' + n), this.startingChips, true, '🤖');
    p.seat = seat;
    if (this.phase !== 'waiting' && this.phase !== 'handover') p.sittingOut = true;
    this.seats[seat] = p;
    this._log(`${p.name} が参加`);
    return { ok: true, seat };
  }

  removeBot() {
    // 最後に着席したCPUを1体外す（進行中は不可）
    if (this.phase !== 'waiting' && this.phase !== 'handover') return { ok: false, error: '進行中は外せません' };
    for (let s = MAX_SEATS - 1; s >= 0; s--) {
      const p = this.seats[s];
      if (p && p.isBot) { this.seats[s] = null; this._log(`${p.name} が退出`); return { ok: true }; }
    }
    return { ok: false, error: 'CPUがいません' };
  }

  setAuto(id, on) {
    const p = this._byId(id);
    if (!p || p.isBot) return { ok: false };
    p.auto = !!on;
    this._log(`${p.name}: ${on ? 'AI代行ON' : 'AI代行OFF'}`);
    return { ok: true };
  }

  removePlayer(id) {
    const p = this._byId(id);
    if (!p) return;
    // 進行中ならフォールド扱い
    if (this._inHand(p)) { p.folded = true; p.lastAction = 'fold'; }
    this.seats[p.seat] = null;
    this._log(`${p.name} が退室`);
    if (this.phase !== 'waiting' && this.phase !== 'handover') this._afterAction();
  }

  setConnected(id, v) {
    const p = this._byId(id);
    if (p) p.connected = v;
  }

  // ---- ハンド開始 ----
  canStart() {
    if (this.champion != null) return false; // 優勝者が決まったら新しいゲームまで開始不可
    // トーナメント：チップのある在席者のみ。キャッシュ：CPUは自動リバイされるので頭数に数える。
    const eligible = this.tournament
      ? this._activeSeats().filter((p) => p.chips > 0)
      : this._activeSeats().filter((p) => p.chips > 0 || p.isBot);
    return eligible.length >= 2 && (this.phase === 'waiting' || this.phase === 'handover');
  }

  // トーナメント：最後の1人になったら優勝者を確定
  _checkChampion() {
    if (!this.tournament) return;
    const seated = this._occupied();
    const withChips = seated.filter((p) => p.chips > 0);
    if (seated.length >= 2 && withChips.length === 1) {
      this.champion = withChips[0].seat;
      for (const p of seated) if (p.chips <= 0) p.eliminated = true;
      this._log(`=== ${withChips[0].name} の優勝！ ===`);
    }
  }

  // トーナメントをリセットして新しいゲームを始める
  resetTournament() {
    this.champion = null;
    for (const p of this._occupied()) { p.chips = this.startingChips; p.eliminated = false; p.sittingOut = false; }
    this.blindLevel = 0; this.handsThisLevel = 0; this.levelDeadline = 0;
    [this.smallBlind, this.bigBlind] = this.blindLevels[0];
    this.phase = 'waiting';
    this._log('新しいゲームを開始');
    return { ok: true };
  }

  _levelUp() {
    this.blindLevel++;
    this._log(`=== ブラインド上昇：レベル${this.blindLevel + 1}（SB${this.blindLevels[this.blindLevel][0]} / BB${this.blindLevels[this.blindLevel][1]}） ===`);
  }

  _maybeAdvanceBlinds() {
    const last = this.blindLevels.length - 1;
    if (this.blindMode === 'time') {
      const now = Date.now();
      if (this.levelDeadline === 0) {
        this.levelDeadline = now + this.levelTime; // 最初のハンドで計時開始
      } else if (now >= this.levelDeadline && this.blindLevel < last) {
        this._levelUp();
        this.levelDeadline = now + this.levelTime;
      }
    } else if (this.blindMode === 'hands') {
      if (this.handsThisLevel >= this.levelHands && this.blindLevel < last) {
        this._levelUp();
        this.handsThisLevel = 0;
      }
      this.handsThisLevel++; // このハンドを現レベルの消化数に加算
    }
    if (this.blindMode !== 'off') [this.smallBlind, this.bigBlind] = this.blindLevels[this.blindLevel];
  }

  // ブラインドの上げ方を変更（すぐ反映、以後のハンドから）
  setBlindConfig({ mode, minutes, hands } = {}) {
    if (mode && ['time', 'hands', 'off'].includes(mode)) this.blindMode = mode;
    if (minutes != null) this.levelTime = Math.max(1, Math.round(minutes * 60000));
    if (hands != null) this.levelHands = Math.max(1, Math.round(hands));
    // 計時/カウントをリセットして新設定で仕切り直し
    this.levelDeadline = this.blindMode === 'time' ? Date.now() + this.levelTime : 0;
    this.handsThisLevel = 0;
    const modeJp = this.blindMode === 'time' ? `${Math.round(this.levelTime / 60000)}分ごと`
      : this.blindMode === 'hands' ? `${this.levelHands}ハンドごと` : '固定（上げない）';
    this._log(`ブラインド設定を変更：${modeJp}`);
    return { ok: true };
  }

  startHand() {
    if (!this.canStart()) return { ok: false, error: '開始条件を満たしていません（チップのある参加者が2人以上必要）' };
    this._maybeAdvanceBlinds();

    // チップ0の人は待機。キャッシュ方式ではCPUのみ自動リバイ。トーナメントでは0=脱落。
    for (const p of this._occupied()) {
      if (!this.tournament && p.isBot && p.chips <= 0) p.chips = this.startingChips;
      p.hole = []; p.bet = 0; p.committed = 0;
      p.folded = false; p.allIn = false; p.hasActed = false; p.lastAction = null;
      p.sittingOut = p.chips <= 0;
      if (this.tournament && p.chips <= 0) p.eliminated = true;
    }

    this.handId += 1;
    this.deck = shuffle(makeDeck());
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastResult = null;
    this.phase = 'preflop';

    // ボタンを次の在席者へ
    this.button = this._nextOccupiedSeat(this.button);

    const players = this._orderFrom(this.button); // ボタンから時計回りの在席プレイヤー
    const inHand = players.filter((p) => !p.sittingOut);

    // ブラインド（ヘッズアップはボタン=SB）
    let sbSeat, bbSeat, firstToAct;
    if (inHand.length === 2) {
      sbSeat = this.button;
      bbSeat = this._nextInHandSeat(this.button);
      firstToAct = this.button; // ヘッズアップのプリフロップはSB(=ボタン)から
    } else {
      sbSeat = this._nextInHandSeat(this.button);
      bbSeat = this._nextInHandSeat(sbSeat);
      firstToAct = this._nextInHandSeat(bbSeat);
    }

    this.sbSeat = sbSeat;
    this.bbSeat = bbSeat;
    this._postBlind(sbSeat, this.smallBlind);
    this._postBlind(bbSeat, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    // 配札（2枚ずつ）
    for (let round = 0; round < 2; round++) {
      for (const p of inHand) p.hole.push(this.deck.pop());
    }

    this.pending = false;
    this.turn = firstToAct;
    // firstToAct が既にオールイン（極小スタック）ならスキップ
    this._skipToActable();
    this._armTurnClock();
    this._log(`--- ハンド#${this.handId} 開始（ボタン: 席${this.button + 1}） ---`);
    return { ok: true };
  }

  _postBlind(seat, amount) {
    const p = this.seats[seat];
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.committed += pay;
    this.pot += pay;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = 'blind';
  }

  // ---- アクション ----
  // action: 'fold' | 'check' | 'call' | 'raise'(amount=最終的な自分のbet額) | 'allin'
  act(id, action, amount) {
    const p = this._byId(id);
    if (!p) return { ok: false, error: 'プレイヤーが見つかりません' };
    if (this.phase === 'waiting' || this.phase === 'handover') return { ok: false, error: '進行中のハンドがありません' };
    if (p.seat !== this.turn) return { ok: false, error: 'あなたの手番ではありません' };
    if (p.folded || p.allIn) return { ok: false, error: 'アクションできない状態です' };

    const toCall = this.currentBet - p.bet;

    if (action === 'fold') {
      p.folded = true; p.lastAction = 'fold'; p.hasActed = true;
      this._log(`${p.name}: フォールド`);
    } else if (action === 'check') {
      if (toCall > 0) return { ok: false, error: 'チェックできません（コール額があります）' };
      p.hasActed = true; p.lastAction = 'check';
      this._log(`${p.name}: チェック`);
    } else if (action === 'call') {
      if (toCall <= 0) return { ok: false, error: 'コール対象がありません' };
      const pay = Math.min(toCall, p.chips);
      this._putIn(p, pay);
      p.hasActed = true; p.lastAction = 'call';
      this._log(`${p.name}: コール ${pay}`);
    } else if (action === 'raise' || action === 'bet') {
      // amount = 自分の最終的な現ストリート合計bet
      let target = Math.floor(amount);
      if (!Number.isFinite(target)) return { ok: false, error: '不正な額です' };
      const maxTarget = p.bet + p.chips; // オールイン上限
      if (target > maxTarget) return { ok: false, error: 'チップが足りません' };
      // 賭けの刻み（既定100）に丸める。ただしオールインちょうどは端数のまま許可。
      if (this.betStep > 1 && target < maxTarget) {
        const minLegal = this.currentBet + this.minRaise;
        target = Math.round(target / this.betStep) * this.betStep;
        if (target < minLegal) target = Math.ceil(minLegal / this.betStep) * this.betStep;
        if (target > maxTarget) target = maxTarget; // 丸めで上限を超えたらオールイン
      }
      const raiseBy = target - this.currentBet;
      const isAllIn = target === maxTarget;
      // 通常はミニマムレイズ以上が必要。オールインなら不足でも許可（ただし他者の再アクションは開かない）
      if (raiseBy < this.minRaise && !isAllIn) {
        return { ok: false, error: `最低レイズは ${this.currentBet + this.minRaise} までです` };
      }
      if (target <= this.currentBet && !(isAllIn && target > p.bet)) {
        return { ok: false, error: 'レイズ額が現在のベットを上回っていません' };
      }
      const pay = target - p.bet;
      this._putIn(p, pay);
      // フルレイズなら betting を再オープン
      if (raiseBy >= this.minRaise) {
        this.minRaise = raiseBy;
        for (const o of this._inHandPlayers()) {
          if (o !== p && !o.allIn) o.hasActed = false;
        }
      }
      this.currentBet = Math.max(this.currentBet, target);
      p.hasActed = true;
      p.lastAction = (this.currentBet > this.bigBlind || this._someoneHasBet()) ? 'raise' : 'bet';
      this._log(`${p.name}: ${p.lastAction === 'raise' ? 'レイズ' : 'ベット'} → ${target}${p.allIn ? '（オールイン）' : ''}`);
    } else {
      return { ok: false, error: '不明なアクションです' };
    }

    this._afterAction();
    return { ok: true };
  }

  _putIn(p, pay) {
    pay = Math.min(pay, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.committed += pay;
    this.pot += pay;
    if (p.chips === 0) p.allIn = true;
  }

  _someoneHasBet() {
    return this._inHandPlayers().some((p) => p.lastAction === 'bet' || p.lastAction === 'raise');
  }

  // アクション後の進行処理
  _afterAction() {
    const alive = this._inHandPlayers(); // フォールドしていない
    if (alive.length <= 1) {
      this._endHandSingleWinner(alive[0]);
      return;
    }

    if (this._roundComplete()) {
      this._collectStreet();
      // すぐには進めず「ため」を作る。実際の進行は resolvePending() で（サーバーが遅延実行）
      this.pending = true;
      this.turn = -1;
      this.turnDeadline = 0;
    } else {
      this._advanceTurn();
      this._armTurnClock();
    }
  }

  // pending を1段階だけ解決する（次のストリートを1枚開く / ショーダウン）。
  // オールイン決着では1段階ずつ pending を立て直し、サーバーが間を置いて再度呼ぶ＝カードが1枚ずつ開く。
  resolvePending() {
    this.pending = false;
    const alive = this._inHandPlayers();
    if (alive.length <= 1) { this._endHandSingleWinner(alive[0]); return; }

    if (this.phase === 'river') { this._showdown(); return; }

    this._dealNextStreet();
    const canAct = this._inHandPlayers().filter((p) => !p.allIn && p.chips > 0);
    if (canAct.length <= 1) {
      // 全員ほぼオールイン：手番を作らず、続きも遅延で自動的に開く
      this.pending = true;
      this.turn = -1;
      this.turnDeadline = 0;
    } else {
      this.turn = this.button;
      this._advanceTurn();
      this._armTurnClock();
    }
  }

  _armTurnClock() {
    this.turnDeadline = this.turn >= 0 ? Date.now() + this.turnTime : 0;
  }

  _roundComplete() {
    const contenders = this._inHandPlayers().filter((p) => !p.allIn);
    if (contenders.length === 0) return true;
    return contenders.every((p) => p.hasActed && p.bet === this.currentBet);
  }

  _advanceTurn() {
    let next = this.turn;
    for (let i = 0; i < MAX_SEATS; i++) {
      next = this._nextInHandSeat(next);
      const p = this.seats[next];
      if (p && !p.folded && !p.allIn) { this.turn = next; return; }
    }
    this.turn = -1;
  }

  _skipToActable() {
    const p = this.seats[this.turn];
    if (!p || p.folded || p.allIn) this._advanceTurn();
  }

  _collectStreet() {
    for (const p of this._occupied()) { p.bet = 0; p.hasActed = false; }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
  }

  // 次のストリートを1段階だけ開く（手番は設定しない）
  _dealNextStreet() {
    if (this.phase === 'preflop') {
      this.deck.pop(); // バーンカード
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else if (this.phase === 'flop') {
      this.deck.pop();
      this.community.push(this.deck.pop());
      this.phase = 'turn';
    } else if (this.phase === 'turn') {
      this.deck.pop();
      this.community.push(this.deck.pop());
      this.phase = 'river';
    }
    this._log(`--- ${this.phase.toUpperCase()} : ${this.community.map(cardToStr).join(' ')} ---`);
  }

  // ---- 決着 ----
  _endHandSingleWinner(winner) {
    winner.chips += this.pot;
    this.lastResult = {
      pots: [{ amount: this.pot, winners: [{ seat: winner.seat, name: winner.name, amount: this.pot }], eligible: [winner.seat] }],
      showdown: false,
      reveals: [],
      board: this.community.map(cardToStr),
    };
    this._log(`${winner.name} がポット ${this.pot} を獲得（他全員フォールド）`);
    this.pot = 0;
    this.phase = 'handover';
    this.turn = -1;
    this.turnDeadline = 0;
    this.pending = false;
    this._checkChampion();
  }

  _showdown() {
    const contenders = this._inHandPlayers();
    // 各コンテンダーの最強ハンドを評価
    const evals = {};
    for (const p of contenders) {
      const seven = [...p.hole, ...this.community];
      evals[p.seat] = evaluateBest(seven);
    }

    // サイドポット構築
    const pots = this._buildPots();
    const potResults = [];
    for (const pot of pots) {
      const eligible = pot.eligible.filter((seat) => evals[seat]); // フォールドは除外済み
      if (eligible.length === 0) continue;
      // 勝者判定
      let best = null;
      let winners = [];
      for (const seat of eligible) {
        const sc = evals[seat].score;
        if (best === null || compareScore(sc, best) > 0) { best = sc; winners = [seat]; }
        else if (compareScore(sc, best) === 0) winners.push(seat);
      }
      // 分配（端数はボタン左から順に1チップずつ）
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      const ordered = this._orderSeatsFromButton(winners);
      const winList = [];
      for (const seat of ordered) {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; }
        this.seats[seat].chips += amt;
        winList.push({ seat, name: this.seats[seat].name, amount: amt });
      }
      potResults.push({ amount: pot.amount, eligible: pot.eligible, winners: winList });
    }

    const reveals = contenders.map((p) => ({
      seat: p.seat,
      name: p.name,
      hole: p.hole.map(cardToStr),
      best: evals[p.seat].cards.map(cardToStr),
      categoryName: evals[p.seat].categoryName,
    }));

    this.lastResult = { pots: potResults, showdown: true, reveals, board: this.community.map(cardToStr) };
    for (const pr of potResults) {
      this._log(`ポット${pr.amount}: ${pr.winners.map((w) => `${w.name}(+${w.amount})`).join(', ')}`);
    }
    this.pot = 0;
    this.phase = 'handover';
    this.turn = -1;
    this.turnDeadline = 0;
    this.pending = false;
    this._checkChampion();
  }

  _buildPots() {
    // このハンドで拠出した全員（フォールド含む）
    const parts = this._occupied()
      .filter((p) => p.committed > 0)
      .map((p) => ({ seat: p.seat, committed: p.committed, folded: p.folded }));
    const pots = [];
    while (parts.some((p) => p.committed > 0)) {
      const min = Math.min(...parts.filter((p) => p.committed > 0).map((p) => p.committed));
      let amount = 0;
      const eligible = [];
      for (const p of parts) {
        if (p.committed > 0) {
          amount += min;
          p.committed -= min;
          if (!p.folded) eligible.push(p.seat);
        }
      }
      // 直前のポットと同じ eligible ならマージ
      const last = pots[pots.length - 1];
      if (last && last._elig === eligible.join(',')) last.amount += amount;
      else pots.push({ amount, eligible, _elig: eligible.join(',') });
    }
    return pots;
  }

  // ---- 状態の取得 ----
  getPublicState() {
    return {
      handId: this.handId,
      phase: this.phase,
      button: this.button,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      bigBlind: this.bigBlind,
      smallBlind: this.smallBlind,
      blindLevel: this.blindLevel,
      blindMode: this.blindMode,
      risingBlinds: this.blindMode !== 'off',
      levelDeadline: this.blindMode === 'time' ? this.levelDeadline : 0,
      levelTime: this.levelTime,
      levelHands: this.levelHands,
      betStep: this.betStep,
      autoNextHand: this.autoNextHand,
      tournament: this.tournament,
      champion: this.champion,
      handsLeft: this.blindMode === 'hands' ? Math.max(0, this.levelHands - this.handsThisLevel) : null,
      nextBlinds: (this.blindMode !== 'off' && this.blindLevel < this.blindLevels.length - 1) ? this.blindLevels[this.blindLevel + 1] : null,
      turn: this.turn,
      turnDeadline: this.turnDeadline,
      turnTime: this.turnTime,
      now: Date.now(),
      community: this.community.map(cardToStr),
      seats: this.seats.map((p) => p && ({
        seat: p.seat,
        name: p.name,
        avatar: p.avatar,
        isBot: p.isBot,
        auto: p.auto,
        eliminated: p.eliminated,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        connected: p.connected,
        sittingOut: p.sittingOut,
        lastAction: p.lastAction,
        hasCards: this._inHand(p) || (this.phase !== 'waiting' && this.phase !== 'handover' && !p.sittingOut),
      })),
      canStart: this.canStart(),
      lastResult: this.phase === 'handover' ? this.lastResult : null,
      log: this.log.slice(-12),
    };
  }

  // 本人にだけ渡す手札とコール額など
  getPrivateState(id) {
    const p = this._byId(id);
    if (!p) return null;
    const toCall = this.turn === p.seat ? Math.max(0, this.currentBet - p.bet) : 0;
    let handName = null;
    let best = null;
    let handRank = null;
    if (p.hole.length === 2 && this.community.length >= 3 && !p.folded) {
      const ev = evaluateBest([...p.hole, ...this.community]);
      handName = ev.categoryName;
      best = ev.cards.map(cardToStr);
      handRank = ev.category;
    }
    return {
      id: p.id,
      seat: p.seat,
      hole: p.hole.map(cardToStr),
      handName,
      handRank,
      best,
      auto: p.auto,
      chips: p.chips,
      isTurn: this.turn === p.seat && !p.folded && !p.allIn && (this.phase !== 'waiting' && this.phase !== 'handover'),
      toCall,
      minRaiseTo: this.currentBet + this.minRaise, // 最低レイズ後の合計
      maxBetTo: p.bet + p.chips,                   // オールイン上限
    };
  }

  // ---- ユーティリティ ----
  _byId(id) { return this.seats.find((s) => s && s.id === id) || null; }
  _occupied() { return this.seats.filter(Boolean); }
  _activeSeats() { return this.seats.filter((p) => p && !p.sittingOut); }
  _inHand(p) { return p && !p.folded && !p.sittingOut && (this.phase !== 'waiting'); }
  _inHandPlayers() {
    return this._occupied().filter((p) => !p.folded && !p.sittingOut && p.hole.length > 0);
  }

  _nextOccupiedSeat(from) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[s];
      if (p && !p.sittingOut) return s;
    }
    return from;
  }
  _nextInHandSeat(from) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[s];
      if (p && !p.sittingOut && p.hole.length > 0 && !p.folded) return s;
    }
    // フォールド者も含めた次席（配札順などに使用）
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i + MAX_SEATS) % MAX_SEATS;
      if (this.seats[s] && !this.seats[s].sittingOut) return s;
    }
    return from;
  }
  _orderFrom(from) {
    const out = [];
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i + MAX_SEATS) % MAX_SEATS;
      if (this.seats[s]) out.push(this.seats[s]);
    }
    return out;
  }
  _orderSeatsFromButton(seats) {
    return [...seats].sort((a, b) => {
      const da = (a - this.button + MAX_SEATS) % MAX_SEATS;
      const db = (b - this.button + MAX_SEATS) % MAX_SEATS;
      return da - db;
    });
  }

  _log(msg) {
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
  }
}
