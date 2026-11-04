// 纯函数单测：倒计时重锚、抗挂机离群、p25–p75 区间、费用折算。
// 这些是「倒计时卡在快完了」「一次挂机污染所有估算」两个真实故障的回归测试。
import test from 'node:test';
import assert from 'node:assert/strict';

let bundle = null;

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      const React = {
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: (initial) => ({ current: initial }),
        createElement: (type, props, children) => ({ type, props, children }),
      };
      bundle = factory((id) => {
        if (id === 'react') return React;
        throw new Error(`unexpected require: ${id}`);
      });
    },
  },
};

await import('../lib/client.js'); // 触发 window.__ModuleLoader__.load

const ctx = {
  slots: {
    inject: (_name, callback) => callback(),
    register: () => {},
  },
};
bundle.apply(ctx);

const {
  TUNING,
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
} = bundle.__internals;

/** 平均 20 tok/s、每步 8 秒的 10 轮历史，正常场景的基座。 */
function normalHistory(count = 10) {
  return Array.from({ length: count }, (_, index) => ({
    tokens: 3000,
    ms: 150000,
    steps: 19,
    llmMs: 140000,
    toolMs: 10000,
  }));
}

function model(history = normalHistory()) {
  return historyModel(history, 0);
}

test('clock / tokens / money 格式稳定', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(59_400), '0:59');
  assert.equal(clock(61_000), '1:01');
  assert.equal(clock(-5), '0:00');

  assert.equal(tokens(840), '840');
  assert.equal(tokens(999), '999');
  assert.equal(tokens(1000), '1.0k');
  assert.equal(tokens(9999), '10.0k');
  assert.equal(tokens(10_000), '10k');

  assert.equal(money(null), null);
  assert.equal(money({ amount: 0.004, symbol: '¥' }), '¥<0.01');
  assert.equal(money({ amount: 0.0161, symbol: '¥' }), '¥0.016');
  assert.equal(money({ amount: 1.234, symbol: '¥' }), '¥1.23');
});

test('weightedQuantile：权重与非法值', () => {
  assert.equal(weightedQuantile([], 0.5), null);
  assert.equal(weightedQuantile([[Number.NaN, 1], [5, 0]], 0.5), null);
  assert.equal(weightedQuantile([[10, 1], [20, 1], [30, 1]], 0.5), 20);
  // 权重都压在小值上时，中位数跟着权重走。
  assert.equal(weightedQuantile([[10, 9], [1000, 1]], 0.5), 10);
  assert.equal(weightedMedian([[10, 1], [20, 1], [30, 1]]), 20);
});

test('effectiveMs：挂机时长不进入样本，真实工作时长优先', () => {
  // 挂机：墙钟 10 小时，实际只干了 3 分钟。
  assert.equal(effectiveMs({ ms: 36_000_000, llmMs: 180_000, toolMs: 0 }), 180_000);
  // 正常：墙钟略大于活跃时长，用墙钟。
  assert.equal(effectiveMs({ ms: 150_000, llmMs: 140_000, toolMs: 10_000 }), 150_000);
  // 老数据没有 llmMs/toolMs：只能信墙钟。
  assert.equal(effectiveMs({ ms: 22_406 }), 22_406);
  assert.equal(activeMsOf({ llmMs: 1000, toolMs: 500 }), 1500);
  assert.equal(activeMsOf({}), 0);
});

test('historyModel：单轮离群不会把目标拉爆', () => {
  const history = normalHistory(9);
  history.push({ tokens: 30_000, ms: 10 * 60 * 60 * 1000, steps: 400, llmMs: 3 * 60 * 60 * 1000, toolMs: 0 });
  const result = historyModel(history, 0);
  // 正常轮次 150 秒左右，离群轮次必须被压回同一量级（< 8 倍中位数）。
  assert.ok(result.targetMs > 0, 'targetMs 应为正数');
  assert.ok(result.targetMs <= 8 * 150_000, `targetMs 被离群值拉爆：${result.targetMs}`);
  assert.ok(Number.isFinite(result.historyRate) && result.historyRate > 0, 'historyRate 应可用');
  assert.ok(result.stepMs > 0 && result.stepMs < 30_000, `stepMs 不合理：${result.stepMs}`);
});

test('historyModel：空历史有先验，不会返回 null', () => {
  const result = historyModel([], 0);
  assert.ok(result.targetMs > 0);
  assert.ok(result.targetTokens > 0);
  assert.ok(result.historyRate > 0);
  assert.ok(result.lowMs <= result.highMs);
});

test('nextEta：正常区间只降不涨，回涨被钳住', () => {
  const anchor = {
    targetMs: 150_000,
    targetTokens: 3000,
    historyRate: 3000 / 150_000,
    lastRemaining: null,
    granted: false,
  };
  let previous = Infinity;
  for (let seconds = 0; seconds <= 120; seconds += 5) {
    const eta = nextEta(anchor, seconds * 1000, Math.round(seconds * 20), model());
    assert.equal(eta.overrun, false, `${seconds}s 不应判为超时`);
    assert.ok(eta.remainingMs !== null && eta.remainingMs >= 0, `${seconds}s remainingMs 非法`);
    assert.ok(eta.remainingMs <= previous, `${seconds}s 倒计时回涨：${previous} → ${eta.remainingMs}`);
    previous = eta.remainingMs;
    anchor.lastRemaining = eta.remainingMs;
    anchor.targetMs = eta.targetMs;
  }
});

test('nextEta：样本刷新最多抬 REANCHOR_JUMP_MS，超过当噪声', () => {
  const anchor = { targetMs: 150_000, targetTokens: 3000, historyRate: 1 / 50, lastRemaining: 100_000 };
  const eta = nextEta(anchor, 10_000, 200, model());
  // byMs = 140_000 > lastRemaining(100_000) + 2000 ⇒ 应被压回 100_000。
  assert.equal(eta.remainingMs, 100_000);
  assert.equal(eta.overrun, false);
});

test('nextEta：超预估只补一次跑道，之后老实说「不知道」', () => {
  const model0 = model();
  const runway = clamp(model0.stepMs, TUNING.RUNWAY_MIN_MS, TUNING.RUNWAY_MAX_MS);
  let anchor = { targetMs: 60_000, targetTokens: 3000, historyRate: 3000 / 150_000, lastRemaining: 0, granted: false };
  let elapsed = 400_000;

  // 第一次超出：给一步跑道，并记住已经补过。
  const first = nextEta(anchor, elapsed, 30_000, model0);
  assert.equal(first.overrun, true, '400s 应判超时');
  assert.equal(first.stale, false, '第一次超时还不算 stale');
  assert.equal(first.granted, true, '第一次超时必须标记已补跑道');
  assert.ok(Number.isFinite(first.remainingMs) && first.remainingMs > 0, '第一次要给正数跑道');
  assert.ok(first.remainingMs <= TUNING.RUNWAY_MAX_MS, `跑道超过封顶：${first.remainingMs}`);
  assert.ok(first.remainingMs >= Math.min(runway, TUNING.RUNWAY_MAX_MS) - 1, '跑道比一步还短');
  assert.ok(first.targetMs > 60_000 && first.targetMs <= elapsed + TUNING.RUNWAY_MAX_MS, `新目标不合理：${first.targetMs}`);

  // 第二次超出：不再编数字，remainingMs 为 null，targetMs 不再变。
  anchor = { ...anchor, targetMs: first.targetMs, lastRemaining: first.remainingMs, granted: first.granted };
  for (let round = 0; round < 8; round += 1) {
    elapsed += 30_000;
    const eta = nextEta(anchor, elapsed, 30_000, model0);
    assert.equal(eta.overrun, true, `第 ${round + 2} 次应判超时`);
    assert.equal(eta.stale, true, '补过跑道后再超时必须是 stale');
    assert.equal(eta.remainingMs, null, 'stale 状态不许再给出剩余时间');
    assert.equal(eta.targetMs, first.targetMs, 'stale 状态目标不许再动');
    anchor = { ...anchor, targetMs: eta.targetMs, granted: eta.granted };
  }
});

test('nextEta：目标缺失时不崩，返回有限跑道', () => {
  const eta = nextEta({ targetMs: null, targetTokens: null, historyRate: null, lastRemaining: null }, 5_000, 100, model());
  assert.ok(Number.isFinite(eta.remainingMs) && eta.remainingMs > 0);
  assert.equal(eta.granted, true, '没有目标时补的跑道也要记账，避免每帧重补');
});

test('intervalOf：p25 ≤ p50 ≤ p75，且剩余区间随时间收窄', () => {
  // 有快有慢的历史，p25/p75 才会拉开，区间才有意义。
  const history = [90_000, 120_000, 150_000, 150_000, 180_000, 210_000, 150_000, 150_000].map((ms) => ({
    tokens: 3000,
    ms,
    steps: 19,
    llmMs: ms - 10_000,
    toolMs: 10_000,
  }));
  const historyModelResult = historyModel(history, 0);
  assert.ok(historyModelResult.lowMs <= historyModelResult.targetMs);
  assert.ok(historyModelResult.targetMs <= historyModelResult.highMs);
  assert.ok(historyModelResult.lowMs < historyModelResult.highMs, '样本有快有慢时区间应拉开');

  const early = intervalOf(historyModelResult, 10_000);
  const later = intervalOf(historyModelResult, 60_000);
  // 剩余区间 = 总量区间减去已用时间 ⇒ 两头都随时间下移。
  assert.ok(early.lowMs > later.lowMs);
  assert.ok(early.highMs > later.highMs);
  assert.ok(early.lowMs <= early.highMs);
  assert.equal(later.lowMs, Math.max(0, historyModelResult.lowMs - 60_000));
});

test('estimateCost：命中/未命中分开算，峰谷价切换', () => {
  const pricing = {
    peakEnabled: true,
    hasPeak: true,
    peakWindows: [{ start: 0, end: 24 }],
    peak: { miss: 0.3, hit: 0.006, out: 1.2 },
    offPeak: { miss: 0.15, hit: 0.003, out: 0.6 },
    fx: 7,
    symbol: '¥',
  };
  // 全命中、全峰时：100万 hit = 0.006 USD × 7 = 0.042
  const hitOnly = estimateCost(pricing, 1_000_000, 1_000_000, 0);
  assert.equal(hitOnly.peakNow, true);
  assert.ok(Math.abs(hitOnly.amount - 0.042) < 1e-9);
  // 混合：10k miss + 50k hit + 3.2k out = 0.003 + 0.0003 + 0.00384 USD → ×7
  const mixed = estimateCost(pricing, 60_000, 50_000, 3200);
  assert.ok(Math.abs(mixed.amount - (0.003 + 0.0003 + 0.00384) * 7) < 1e-9);
  // 非法输入 → null，不冒充 0 元
  assert.equal(estimateCost(pricing, null, 0, 1000), null);
  assert.equal(estimateCost(pricing, 1000, 0, Number.NaN), null);
  assert.equal(estimateCost(null, 1000, 0, 1000), null);
});
