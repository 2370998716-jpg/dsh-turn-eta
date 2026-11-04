window.__ModuleLoader__.load({
  id: 'dsh-turn-eta',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    /** Projection key registered by the host half. */
    const NS = 'turnEta';
    /** Header actions row: after the built-in job indicator (order 21). */
    const ORDER = 22;

    /**
     * Tuning for the countdown. Numbers, not taste: each one is tied to the
     * failure it prevents.
     */
    const TUNING = {
      /** How much of the frozen target must be spent before samples may even
       * be looked at again. Below half, the estimate is still honest. */
      REANCHOR_AT: 0.5,
      /** Floor of the extra runway granted when a turn outruns its target. */
      RUNWAY_MIN_MS: 2000,
      /** Ceiling of that runway; beyond this the estimate is a lie anyway. */
      RUNWAY_MAX_MS: 15000,
      /** A duration above this multiple of the median is treated as挂机/ outlier. */
      OUTLIER_CAP: 8,
      /** A refresh may raise the countdown only by more than this, otherwise it
       * is noise and the previous value stands. */
      REANCHOR_JUMP_MS: 2000,
    };

    const style = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontVariantNumeric: 'tabular-nums',
      fontSize: 11,
      lineHeight: '16px',
      opacity: 0.68,
      whiteSpace: 'nowrap',
      userSelect: 'none',
    };

    function clamp(value, low, high) {
      return Math.min(high, Math.max(low, value));
    }

    /** `m:ss` for a duration in milliseconds. */
    function clock(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    /** Compact token count: 840 → "840", 3400 → "3.4k". */
    function tokens(n) {
      if (n >= 10000) return `${Math.round(n / 1000)}k`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return String(n);
    }

    /** Weighted median of [value, weight] pairs, or null when nothing usable.
     * Weights let recent turns count more than old ones.
     */
    function weightedMedian(pairs) {
      return weightedQuantile(pairs, 0.5);
    }

    /** Weighted quantile (q in 0..1) of [value, weight] pairs, or null. */
    function weightedQuantile(pairs, q) {
      const rows = pairs.filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > 0);
      if (rows.length === 0) return null;
      rows.sort((a, b) => a[0] - b[0]);
      const total = rows.reduce((sum, pair) => sum + pair[1], 0);
      let accumulated = 0;
      for (const [value, weight] of rows) {
        accumulated += weight;
        if (accumulated >= total * q) return value;
      }
      return rows[rows.length - 1][0];
    }

    /** Time actually spent working in one finished turn. */
    function activeMsOf(turn) {
      const llm = Number.isFinite(turn.llmMs) ? turn.llmMs : 0;
      const tool = Number.isFinite(turn.toolMs) ? turn.toolMs : 0;
      return llm + tool;
    }

    /**
     * The wall clock of a finished turn, unless it is far longer than the time
     * the turn actually worked: then the gap is waiting (tab hidden, machine
     * asleep, user away) and must not inflate the estimate (①-②).
     */
    function effectiveMs(turn) {
      const wall = Number.isFinite(turn.ms) ? turn.ms : 0;
      const active = activeMsOf(turn);
      if (active > 0 && wall > active * 2 + 20000) return active;
      return wall;
    }

    /**
     * Shared "how big / how long is a reply like this" reduction over history.
     * Returns the frozen targets plus the spread used for the tooltip range.
     */
    function historyModel(history, producedTokens) {
      const rows = (history ?? []).slice(-12).filter((turn) => turn && turn.tokens > 0 && turn.ms > 0);
      // 全新会话/刚装插件时没有任何样本，用一组粗略先验，好过整条不显示。
      const sample = rows.length > 0 ? rows : [{ tokens: 8000, ms: 100000, steps: 0 }];
      const similar = sample.filter((turn) => turn.tokens >= Math.max(600, producedTokens * 0.8));
      const pool = similar.length > 0 ? similar : sample;
      const weights = pool.map((_, index) => 1 + (0.6 * index) / Math.max(1, pool.length - 1));

      const durations = pool.map((turn) => effectiveMs(turn));
      const median = weightedMedian(pool.map((turn, index) => [durations[index], weights[index]]));
      const cap = median !== null && median > 0 ? median * TUNING.OUTLIER_CAP : Infinity;
      const capped = durations.map((ms) => clamp(ms, 1, cap));

      const tokensPair = pool.map((turn, index) => [turn.tokens, weights[index]]);
      const msPair = pool.map((turn, index) => [capped[index], weights[index]]);

      const targetTokensWeighted = weightedMedian(tokensPair);
      const targetMs = weightedMedian(msPair);
      const historyRate = weightedMedian(pool.map((turn, index) => [turn.tokens / capped[index], weights[index]]));
      const lowMs = weightedQuantile(msPair, 0.25);
      const highMs = weightedQuantile(msPair, 0.75);

      const perStep = pool
        .map((turn, index) => (Number.isFinite(turn.steps) && turn.steps > 0 ? capped[index] / turn.steps : null))
        .filter((value) => value !== null && value > 0);
      const stepMs = perStep.length > 0 ? weightedMedian(perStep.map((value) => [value, 1])) : null;

      return {
        targetTokens: targetTokensWeighted,
        targetMs,
        historyRate,
        lowMs,
        highMs,
        stepMs,
      };
    }

    /**
     * One step of the countdown. Pure: given the per-turn frozen anchor, the
     * elapsed time and how many tokens came out so far, return what to show.
     *
     * The countdown only walks down. When a turn outruns its frozen target it
     * used to sit on 「快完了」 for minutes (the min() below can never go up and
     * nothing re-anchored). Now the target is pushed to `elapsed + runway`, so
     * the row keeps telling the truth: one more step's worth of runway, again
     * and again, at most RUNWAY_MAX_MS at a time (①③).
     */
    function nextEta(prev, elapsedMs, producedTokens, model) {
      const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
      const stepMs = Number.isFinite(model.stepMs) && model.stepMs > 0 ? model.stepMs : 8000;
      const runway = clamp(stepMs, TUNING.RUNWAY_MIN_MS, TUNING.RUNWAY_MAX_MS);

      const targetMs = Number.isFinite(prev.targetMs) ? prev.targetMs : null;
      const targetTokens = Number.isFinite(prev.targetTokens) ? prev.targetTokens : null;
      const rate = Number.isFinite(prev.historyRate) && prev.historyRate > 0 ? prev.historyRate : null;

      const byMs = targetMs === null ? Infinity : targetMs - elapsed;
      const byTokens =
        targetTokens !== null && rate !== null ? Math.max(0, targetTokens - producedTokens) / rate : Infinity;

      let remainingMs = Math.min(byMs, byTokens);
      let nextTarget = targetMs;
      let overrun = false;

      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        overrun = true;
        // 越跑越离谱时，跑道给宽一点，但封顶 RUNWAY_MAX_MS：再往下就是编数字。
        const overshoot = targetMs === null ? 0 : Math.max(0, elapsed - targetMs);
        const bonus = clamp(overshoot * 0.25, 0, TUNING.RUNWAY_MAX_MS - runway);
        nextTarget = Math.max(targetMs ?? 0, elapsed + runway + bonus);
        remainingMs = nextTarget - elapsed;
      }

      // 没跑过目标时不许回涨：样本刷新最多把它抬一点点，超过就当噪声丢掉。
      const last = Number.isFinite(prev.lastRemaining) ? prev.lastRemaining : null;
      if (!overrun && last !== null && remainingMs > last + TUNING.REANCHOR_JUMP_MS) {
        remainingMs = last;
      }

      if (!Number.isFinite(remainingMs)) {
        return { targetMs: nextTarget, remainingMs: null, overrun };
      }
      return { targetMs: nextTarget, remainingMs: Math.max(0, remainingMs), overrun };
    }

    /** Remaining p25–p75 window, only ever shown in the tooltip. */
    function intervalOf(model, elapsedMs) {
      const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
      const low = Number.isFinite(model.lowMs) ? Math.max(0, model.lowMs - elapsed) : null;
      const high = Number.isFinite(model.highMs) ? Math.max(0, model.highMs - elapsed) : null;
      if (low === null || high === null) return null;
      return { lowMs: Math.min(low, high), highMs: Math.max(low, high) };
    }

    /**
     * "This reply so far": wall clock and produced tokens, plus an explicitly
     * estimated remaining time derived from how long turns of a similar size
     * took before. Nothing here is known ahead of time, so the estimate is
     * labelled 估约 and disappears when there is no history to lean on.
     */
    function TurnEtaAction(props) {
      const useProjection = props.useProjection;
      const view = typeof useProjection === 'function' ? useProjection(NS) : undefined;
      const running = view !== undefined && view.start !== null && view.end === null;
      const [, tick] = React.useState(0);
      // 本轮冻结的估算目标（m00549）：倒计时只往下走，不能因为样本刷新而回升。
      const anchor = React.useRef({ turn: -1, targetTokens: null, targetMs: null, historyRate: null, lastRemaining: null });

      React.useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, [running, view === undefined ? 0 : view.turn]);

      if (view === undefined || view.start === null) return null;
      const now = Date.now();
      const end = view.end ?? now;
      const elapsed = Math.max(0, end - view.start);
      if (!Number.isFinite(elapsed) || elapsed > 24 * 60 * 60 * 1000) return null;

      const parts = [running ? `⏱ ${clock(elapsed)}` : `✔ ${clock(elapsed)}`];
      if (view.tokens > 0) parts.push(`${tokens(view.tokens)} tok`);
      const speed = view.llmMs > 0 && view.tokens > 0 ? view.tokens / (view.llmMs / 1000) : null;
      if (speed !== null && speed >= 0.1) parts.push(`${speed.toFixed(1)} tok/s`);
      if (running && view.toolBusy === true) parts.push('工具中');

      let title = '本轮已用时长 · 已产出 token · 生成速度；剩余的「估约」按历史同长度回复推算，不是确定值';
      if (running) {
        const model = historyModel(view.history, view.tokens);
        if (anchor.current.turn !== view.turn) {
          anchor.current = {
            turn: view.turn,
            targetTokens: model.targetTokens,
            targetMs: model.targetMs,
            historyRate: model.historyRate,
            lastRemaining: null,
          };
        }

        const eta = nextEta(anchor.current, elapsed, view.tokens, model);
        anchor.current.targetMs = eta.targetMs;
        if (eta.remainingMs !== null) {
          anchor.current.lastRemaining = eta.remainingMs;
          parts.push(eta.remainingMs <= 1500 ? '快完了' : `估约 ${clock(eta.remainingMs)}`);
        }

        const interval = intervalOf(model, elapsed);
        if (interval !== null && eta.overrun === false) {
          title += `；历史区间约 ${clock(interval.lowMs)}–${clock(interval.highMs)}（p25–p75）`;
        }
      }

      return h('span', { style, title }, parts.join(' · '));
    }

    /**
     * Rough money for one reply: the prompt side is the context we just sent,
     * the output side is the median size of earlier replies. Prices come from
     * the cost-meter ledger (USD / million tokens), converted with its own rate.
     */
    function estimateCost(pricing, inputTokens, cachedTokens, outputTokens) {
      if (pricing === null || pricing === undefined) return null;
      if (![inputTokens, cachedTokens, outputTokens].every((n) => Number.isFinite(n))) return null;
      const hour = new Date().getHours();
      const peakNow =
        pricing.peakEnabled === true &&
        pricing.hasPeak === true &&
        (pricing.peakWindows ?? []).some((w) => hour >= w.start && hour < w.end);
      const table = peakNow ? pricing.peak : pricing.offPeak;
      if (table === undefined || table === null) return null;
      const [miss, hit, out] = [table.miss, table.hit, table.out];
      if (![miss, hit, out].every((n) => Number.isFinite(n) && n >= 0)) return null;
      const missTokens = Math.max(0, inputTokens - Math.max(0, cachedTokens));
      const hitTokens = Math.max(0, Math.min(cachedTokens, inputTokens));
      const usd = (missTokens / 1e6) * miss + (hitTokens / 1e6) * hit + (outputTokens / 1e6) * out;
      const amount = usd * (Number.isFinite(pricing.fx) && pricing.fx > 0 ? pricing.fx : 1);
      return { amount, symbol: pricing.symbol ?? '¥', peakNow };
    }

    /** `¥0.042` style, with small amounts never rounding down to zero. */
    function money(cost) {
      if (cost === null) return null;
      if (cost.amount < 0.01) return `${cost.symbol}<0.01`;
      if (cost.amount < 1) return `${cost.symbol}${cost.amount.toFixed(3)}`;
      return `${cost.symbol}${cost.amount.toFixed(2)}`;
    }

    const dockStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontVariantNumeric: 'tabular-nums',
      fontSize: 11,
      lineHeight: '18px',
      opacity: 0.62,
      whiteSpace: 'nowrap',
      userSelect: 'none',
    };

    /**
     * Pre-send estimate in the composer dock: what this reply will probably
     * cost, in tokens, seconds and money, so the send button can be a decision
     * rather than a guess. Nothing is hidden while a turn is running; this line
     * simply goes quiet then, because the header already shows live progress.
     */
    function ComposerEstimate(props) {
      const useProjection = props.useProjection;
      const view = typeof useProjection === 'function' ? useProjection(NS) : undefined;
      if (view === undefined) return null;
      if (view.start !== null && view.end === null) return null;

      const model = historyModel(view.history, 0);
      const { targetTokens, targetMs } = model;
      const outputTokens = targetTokens ?? 8000;
      const context = view.contextTokens;
      const inputTokens = context !== null && context !== undefined && Number.isFinite(context.total) ? context.total : null;
      const cachedTokens = inputTokens === null ? 0 : Number.isFinite(context.cached) ? context.cached : 0;
      const cost = inputTokens === null ? null : estimateCost(view.pricing, inputTokens, cachedTokens, outputTokens);

      const parts = [];
      parts.push(`预计 ${tokens(Math.round(outputTokens))} tok 产出`);
      if (inputTokens !== null) parts.push(`上下文 ${tokens(inputTokens)}`);
      const price = money(cost);
      if (price !== null) parts.push(`≈${price}`);
      if (Number.isFinite(targetMs) && targetMs > 0) parts.push(`~${clock(targetMs)}`);

      let title =
        '发送前的粗略预估：产出 token 取历史同长度回复的中位数，钱按 cost-meter 价格表折算（含上下文输入），时间取历史耗时中位数。实际值只有跑完才知道。';
      if (Number.isFinite(model.lowMs) && Number.isFinite(model.highMs)) {
        title += ` 历史区间 ${clock(model.lowMs)}–${clock(model.highMs)}（p25–p75）。`;
      }

      return h('span', { style: dockStyle, title }, `⚖ ${parts.join(' · ')}`);
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'turn-eta',
            order: ORDER,
          },
          TurnEtaAction,
        ),
      );
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'turn-eta-estimate',
            order: 6,
          },
          ComposerEstimate,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    // 测试入口：bundle 里不能 import，纯函数从这里出去给 test/eta.test.mjs 用。
    exports.__internals = {
      TUNING,
      NS,
      ORDER,
      clamp,
      clock,
      tokens,
      weightedQuantile,
      weightedMedian,
      activeMsOf,
      effectiveMs,
      historyModel,
      nextEta,
      intervalOf,
      estimateCost,
      money,
    };
    return module.exports;
  },
});
