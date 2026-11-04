// 估算逻辑冒烟测试：把 client bundle 里的组件抓出来，喂几种真实形状的 view，
// 打印它渲染的文本，确认没有 NaN / 空串，且随数据变化合理。
const components = {};
let bundle = null;

// 模拟 React 的持久状态：同一「组件实例」反复渲染时 useRef 要能拿到同一个对象，
// 否则「倒计时只减不增」的钳位在测试里永远不生效（真实 UI 里它是跨渲染保留的）。
const refSlots = [];
let refCursor = 0;

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      const React = {
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: (initial) => {
          if (refCursor >= refSlots.length) refSlots.push({ current: initial });
          return refSlots[refCursor++];
        },
        createElement: (type, props, children) => ({ type, props, children }),
      };
      bundle = factory((id) => {
        if (id === 'react') return React;
        throw new Error(`unexpected require: ${id}`);
      });
    },
  },
};

const ctx = {
  slots: {
    inject: (_name, callback) => callback(),
    register: (meta, Component) => {
      components[meta.id] = Component;
    },
  },
};
await import('../lib/client.js'); // 触发 window.__ModuleLoader__.load
bundle.apply(ctx);
const component = components['turn-eta'];
const composer = components['turn-eta-estimate'];
if (typeof component !== 'function') throw new Error('header component not captured');
if (typeof composer !== 'function') throw new Error('composer component not captured');

const history = [
  { tokens: 58790, ms: 570624 },
  { tokens: 3179, ms: 22406 },
  { tokens: 1305, ms: 10740 },
];

function render(view) {
  refCursor = 0;
  const element = component({ useProjection: () => view });
  if (element === null) return '(hidden)';
  return element.children;
}

const cases = [
  ['无历史·刚开始', { turn: 9, start: Date.now() - 3000, end: null, steps: 1, tokens: 120, llmMs: 2000, toolMs: 0, history: [], toolBusy: false }],
  ['无历史·一半', { turn: 9, start: Date.now() - 60000, end: null, steps: 4, tokens: 3000, llmMs: 40000, toolMs: 8000, history: [], toolBusy: false }],
  ['有历史·早期', { turn: 3, start: Date.now() - 5000, end: null, steps: 1, tokens: 400, llmMs: 3000, toolMs: 0, history, toolBusy: true }],
  ['有历史·中期', { turn: 3, start: Date.now() - 40000, end: null, steps: 3, tokens: 2500, llmMs: 28000, toolMs: 6000, history, toolBusy: false }],
  ['有历史·超时', { turn: 3, start: Date.now() - 400000, end: null, steps: 8, tokens: 30000, llmMs: 300000, toolMs: 60000, history, toolBusy: false }],
  ['已结束', { turn: 3, start: Date.now() - 30000, end: Date.now(), steps: 2, tokens: 1800, llmMs: 20000, toolMs: 4000, history, toolBusy: false }],
];

for (const [label, view] of cases) console.log(label.padEnd(14), render(view));

// 发送前预估（m00480）：上下文口径必须是「未命中 + 命中」的总量，钱按 cost-meter 价格表折算。
const pricing = {
  symbol: '¥',
  currency: 'CNY',
  fx: 6.6483,
  hasPeak: true,
  peakEnabled: false,
  peakWindows: [{ start: 1, end: 4 }],
  offPeak: { miss: 0.15, hit: 0.003, out: 0.6 },
  peak: { miss: 0.3, hit: 0.006, out: 1.2 },
};
const idleView = {
  turn: 4,
  start: 1,
  end: 2,
  steps: 3,
  tokens: 3179,
  llmMs: 20000,
  toolMs: 2000,
  history,
  toolBusy: false,
  contextTokens: { total: 60000, cached: 58000, fresh: 2000 },
  pricing,
};
refCursor = 0;
const dock = composer({ useProjection: () => idleView });
const dockText = dock === null ? '(hidden)' : dock.children;
console.log('发送前预估    ', dockText);
if (!/^⚖ 预计 .+ tok 产出 · 上下文 60k · ≈¥0\.\d+ · ~\d+:\d\d$/.test(dockText)) {
  throw new Error(`COMPOSER_ESTIMATE_BAD: ${dockText}`);
}
// 2000 未命中 + 58000 命中 + ~3k 产出 ≈ (2000*0.15 + 58000*0.003 + 3200*0.6)/1e6*6.6483 ≈ ¥0.028
refCursor = 0;
console.log('运行中·收起   ', composer({ useProjection: () => ({ ...idleView, start: 1, end: null }) }));

// 倒计时单调性（m00549）：「估约」必须随 elapsed 增长只减不增。
// tokens 按 90/s 涨、历史池随 tokens 变（正是原先回涨的触发条件）。
let previous = Number.POSITIVE_INFINITY;
let monotonic = true;
for (const seconds of [5, 10, 20, 40, 80, 160, 240]) {
  const view = {
    turn: 42,
    start: Date.now() - seconds * 1000,
    end: null,
    steps: Math.ceil(seconds / 8),
    tokens: seconds * 90,
    llmMs: seconds * 800,
    toolMs: seconds * 100,
    history,
    toolBusy: false,
  };
  const text = render(view);
  const hit = /估约 (\d+):(\d\d)/.exec(text);
  const value = hit === null ? 0 : Number(hit[1]) * 60 + Number(hit[2]);
  if (value > previous) {
    monotonic = false;
    console.log('  回涨', previous, '→', value, text);
  }
  previous = value;
  console.log(`倒计时 ${String(seconds).padStart(3)}s`, text);
}
if (!monotonic) throw new Error('COUNTDOWN_REGRESSION');
console.log('COUNTDOWN_OK');
