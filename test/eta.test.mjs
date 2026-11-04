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

test('nextEta：中位线以内只降不涨', () => {
  const base = model();
  let anchor = {
    targetMs: base.targetMs,
    baseMs: base.targetMs,
    ceilingMs: base.highMs,
    targetTokens: base.targetTokens,
    historyRate: base.historyRate,
    lastRemaining: null,
    extended: false,
  };
  let previous = Number.POSITIVE_INFINITY;
  for (let elapsed = 0; elapsed < base.targetMs; elapsed += 5_000) {
    const eta = nextEta(anchor, elapsed, 0, base);
    assert.equal(eta.overrun, false, `${elapsed}ms 还在 p50 以内，不该报超预估`);
    assert.equal(eta.extended, false, `${elapsed}ms 不该升级措辞`);
    assert.ok(eta.remainingMs !== null && eta.remainingMs >= 0, `${elapsed}ms 剩余时间非法`);
    assert.ok(eta.remainingMs <= previous, `${elapsed}ms 倒计时回涨：${previous} → ${eta.remainingMs}`);
    previous = eta.remainingMs;
    anchor = {
      ...anchor,
      lastRemaining: eta.remainingMs,
      targetMs: eta.targetMs,
      baseMs: eta.baseMs,
      ceilingMs: eta.ceilingMs,
      extended: eta.extended,
    };
  }
});

test('nextEta：样本刷新最多抬 REANCHOR_JUMP_MS，超过当噪声', () => {
  const anchor = {
    targetMs: 150_000,
    baseMs: 150_000,
    ceilingMs: 150_000,
    targetTokens: 3000,
    historyRate: 1 / 50,
    lastRemaining: 20_000,
    extended: false,
  };
  // byMs = 145_000，远超历史剩余 20_000 ⇒ 只允许小幅回涨，超出部分压回。
  const eta = nextEta(anchor, 5_000, 0, model());
  assert.equal(eta.overrun, false);
  assert.equal(eta.remainingMs, 20_000);
});

test('nextEta：p50 到 p75 之间只改口一次「最多约」，过了 p75 才说超预估', () => {
  // 用显式分布，别依赖 normalHistory 的具体样本：p50 = 2.5min，p75 = 3.5min。
  const base = {
    targetMs: 150_000,
    highMs: 210_000,
    lowMs: 90_000,
    targetTokens: 3000,
    historyRate: 3000 / 150_000,
    stepMs: 12_000,
  };
  const baseMs = base.targetMs;
  const ceilingMs = base.highMs;
  assert.ok(ceilingMs > baseMs, `p75 应大于中位数：${baseMs} → ${ceilingMs}`);
  const anchor = {
    targetMs: baseMs,
    baseMs,
    ceilingMs,
    targetTokens: base.targetTokens,
    historyRate: base.historyRate,
    lastRemaining: 0,
    extended: false,
  };

  // 阶段 2：越过中位数但仍在 p75 内 —— 升级措辞，但给的数字是诚实上界。
  const mid = nextEta(anchor, baseMs + 1_000, 0, base);
  assert.equal(mid.overrun, true);
  assert.equal(mid.extended, true);
  assert.equal(mid.stale, false);
  assert.equal(mid.targetMs, ceilingMs);
  assert.ok(mid.remainingMs > 0 && mid.remainingMs <= ceilingMs - baseMs);

  // 阶段 2 每次问都是同一个上界，不会继续往后挪。
  const later = nextEta({ ...anchor, extended: true, lastRemaining: mid.remainingMs }, baseMs + 2_000, 0, base);
  assert.equal(later.targetMs, ceilingMs);
  assert.equal(later.remainingMs, ceilingMs - (baseMs + 2_000));

  // 阶段 3：越过 p75 —— 目标冻结，不再编数字。
  let eta = nextEta({ ...anchor, extended: true }, ceilingMs + 1_000, 0, base);
  assert.equal(eta.overrun, true);
  assert.equal(eta.stale, true);
  assert.equal(eta.remainingMs, null);
  const frozen = eta.targetMs;
  for (let round = 0; round < 5; round += 1) {
    eta = nextEta({ ...anchor, extended: true }, ceilingMs + 60_000 * (round + 2), 0, base);
    assert.equal(eta.stale, true, `第 ${round + 2} 次问必须直接说超预估`);
    assert.equal(eta.remainingMs, null);
    assert.equal(eta.targetMs, frozen);
  }
});

test('nextEta：目标缺失时不崩，只给一次跑道', () => {
  const noTarget = {
    targetMs: null,
    baseMs: null,
    ceilingMs: null,
    targetTokens: null,
    historyRate: null,
    lastRemaining: null,
    extended: false,
  };
  const first = nextEta(noTarget, 5_000, 100, model());
  assert.ok(Number.isFinite(first.remainingMs) && first.remainingMs > 0);
  assert.ok(Number.isFinite(first.baseMs));
  assert.equal(first.extended, true, '没有目标时补的跑道要记账，避免每帧重给');

  const second = nextEta({ ...noTarget, extended: true }, 40_000, 100, model());
  assert.equal(second.stale, true);
  assert.equal(second.remainingMs, null);
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
