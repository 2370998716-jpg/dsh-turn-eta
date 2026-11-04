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
      // 本轮冻结的估算目标（m00549）：倒计时只能往下走，不能因为样本刷新而回升。
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

      // 剩余时间：目标大小按轮冻结，倒计时只准减、不准增。
      // 冻结是必须的 —— 目标要是跟着已产出 token 重算，工具停顿那几秒里速度掉下去，
      // 算出来的剩余反而变大，表就像在往上爬（m00549 反馈：33→34→35）。
      // 冻结之后两个候选量都随时间单调不增：targetMs-elapsed 严格递减；
      // (targetTokens-tokens)/historyRate 随 tokens 增长递减。取 min 仍然单调。
      if (running) {
        const rows = (view.history ?? []).slice(-12).filter((turn) => turn && turn.tokens > 0 && turn.ms > 0);
        // 全新会话/刚装插件时没有任何样本，用一组粗略先验，好过整条不显示。
        const sample = rows.length > 0 ? rows : [{ tokens: 8000, ms: 100000 }];
        const similar = sample.filter((turn) => turn.tokens >= Math.max(600, view.tokens * 0.8));
        const pool = similar.length > 0 ? similar : sample;
        const weights = pool.map((_, index) => 1 + (0.6 * index) / Math.max(1, pool.length - 1));
        const pick = (read) => weightedMedian(pool.map((turn, index) => [read(turn), weights[index]]));

        if (anchor.current.turn !== view.turn) {
          anchor.current = {
            turn: view.turn,
            targetTokens: pick((turn) => turn.tokens),
            targetMs: pick((turn) => turn.ms),
            historyRate: pick((turn) => turn.tokens / turn.ms),
            lastRemaining: null,
          };
        }

        const frozen = anchor.current;
        const candidates = [];
        if (frozen.targetMs !== null) candidates.push(frozen.targetMs - elapsed);
        const rate = frozen.historyRate;
        if (frozen.targetTokens !== null && rate !== null && rate > 0 && view.tokens < frozen.targetTokens) {
          candidates.push((frozen.targetTokens - view.tokens) / rate);
        }

        const usable = candidates.filter((n) => Number.isFinite(n));
        if (usable.length > 0) {
          const remainingMs = Math.max(0, Math.min(...usable));
          // 双保险：同一轮里哪怕样本变了，也不许显示得比上一次多。
          const shown = frozen.lastRemaining === null ? remainingMs : Math.min(remainingMs, frozen.lastRemaining);
          frozen.lastRemaining = shown;
          parts.push(shown <= 1500 ? '快完了' : `估约 ${clock(shown)}`);
        }
      }

      return h(
        'span',
        {
          style,
          title: '本轮已用时长 · 已产出 token · 生成速度；剩余的「估约」按历史同长度回复推算，不是确定值',
        },
        parts.join(' · '),
      );
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

    /** Shared "how big / how long is a reply like this" reduction over history. */
    function historyModel(history, producedTokens) {
      const rows = (history ?? []).slice(-12).filter((turn) => turn && turn.tokens > 0 && turn.ms > 0);
      const sample = rows.length > 0 ? rows : [{ tokens: 8000, ms: 100000 }];
      const similar = sample.filter((turn) => turn.tokens >= Math.max(600, producedTokens * 0.8));
      const pool = similar.length > 0 ? similar : sample;
      const weights = pool.map((_, index) => 1 + (0.6 * index) / Math.max(1, pool.length - 1));
      const pick = (read) => weightedMedian(pool.map((turn, index) => [read(turn), weights[index]]));
      return { targetTokens: pick((turn) => turn.tokens), targetMs: pick((turn) => turn.ms) };
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

      const { targetTokens, targetMs } = historyModel(view.history, 0);
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

      return h(
        'span',
        {
          style: dockStyle,
          title:
            '发送前的粗略预估：产出 token 取历史同长度回复的中位数，钱按 cost-meter 价格表折算（含上下文输入），时间取历史耗时中位数。实际值只有跑完才知道。',
        },
        `⚖ ${parts.join(' · ')}`,
      );
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
    return module.exports;
  },
});
