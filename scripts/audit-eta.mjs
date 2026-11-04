// 机器审计：用真实历史数据回测「超预估」是否出现过早。
//
// 用法：node scripts/audit-eta.mjs [--json]
//
// 判定逻辑（对应 lib/client.js 的锚点）：
//   回合开始时 producedTokens = 0 ⇒ historyModel 的 similar 过滤等价于 tokens >= 600，
//   targetMs 取相似回合耗时的加权中位数。回合结束时若墙钟超过 targetMs，头部就会显示
//   「超预估」。所以：
//     actual <= target              → ok（没触发）
//     target < actual <= p75        → premature（时长还在历史正常带内就喊超预估，估计偏低）
//     p75 < actual                  → genuine（这轮确实比历史长，喊得有道理）
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE = process.env.DSH_TURN_ETA_STORE
  || join(homedir(), '.dsh', 'storages', 'dsh-turn-eta', 'history.json');

// client.js 是 window.__ModuleLoader__ 的 browser bundle，用最小桩把它加载进来，
// 直接复用产品代码里的 historyModel，避免审计和生产算法漂移。
let loaded = null;
async function loadInternals() {
  if (loaded) return loaded;
  const clientPath = join(fileURLToPath(new URL('..', import.meta.url)), 'lib', 'client.js');
  const refSlots = [];
  let refCursor = 0;
  const React = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => {
      if (refCursor < refSlots.length) return refSlots[refCursor++];
      const slot = { current: initial };
      refSlots.push(slot);
      refCursor += 1;
      return slot;
    },
    createElement: (type, props, children) => ({ type, props, children }),
  };
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        loaded = factory((id) => (id === 'react' ? React : (() => { throw new Error(`unexpected require: ${id}`); })())).__internals;
      },
    },
  };
  await import(pathToFileURL(clientPath).href);
  if (!loaded || typeof loaded.historyModel !== 'function') throw new Error('AUDIT_LOAD_FAILED');
  return loaded;
}

function effective(record) {
  const wall = Number(record.ms) || 0;
  const active = (Number(record.llmMs) || 0) + (Number(record.toolMs) || 0);
  if (active > 0 && wall > active * 2 + 20000) return active;
  return wall;
}

function quantile(values, q) {
  const list = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const index = (list.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return list[low];
  return list[low] + (list[high] - list[low]) * (index - low);
}

function dedupe(turns) {
  const out = [];
  let dropped = 0;
  for (const turn of turns) {
    const prev = out[out.length - 1];
    const same = prev
      && prev.tokens === turn.tokens
      && prev.ms === turn.ms
      && prev.steps === turn.steps
      && (prev.toolMs ?? null) === (turn.toolMs ?? null)
      && (prev.llmMs ?? null) === (turn.llmMs ?? null);
    if (same) { dropped += 1; continue; }
    out.push(turn);
  }
  return { turns: out, dropped };
}

const raw = JSON.parse(readFileSync(STORE, 'utf8'));
const { turns, dropped } = dedupe(Array.isArray(raw.turns) ? raw.turns : []);
const internals = await loadInternals();
const WINDOW = 12;

const rows = [];
for (let index = 1; index < turns.length; index += 1) {
  const prior = turns.slice(Math.max(0, index - WINDOW), index);
  const model = internals.historyModel(prior, 0);
  // 照抄 TurnEtaAction 的开局：用 historyModel 冻结目标，再把 baseMs（中位）/ ceilingMs（p75）
  // 一起种进锚点。不播种 baseMs 时 nextEta 只会当「没历史」，全表失真。
  const anchor = {
    targetMs: model.targetMs,
    baseMs: model.targetMs,
    targetTokens: model.targetTokens,
    historyRate: model.historyRate,
    ceilingMs: model.highMs,
    lastRemaining: null,
    extended: false,
  };
  const first = internals.nextEta(anchor, 0, 0, model);
  const target = Number.isFinite(first.baseMs) ? first.baseMs : first.targetMs;
  const ceiling = Number.isFinite(first.ceilingMs) ? first.ceilingMs : null;
  const actual = effective(turns[index]);
  const pool = prior.filter((t) => (Number(t.tokens) || 0) > 0).map(effective).filter((v) => v > 0);
  const median = quantile(pool, 0.5);
  const p75 = quantile(pool, 0.75);
  // 三阶段判定：中位数以内 = ok；中位数到 p75 之间 = extended（界面只改口「最多约」）；
  // 超过 p75 = overrun（才允许说「超预估」）。
  let verdict = 'ok';
  if (actual > target) verdict = ceiling !== null && actual <= ceiling ? 'extended' : 'overrun';
  rows.push({
    turn: index + 1,
    tokens: turns[index].tokens,
    steps: turns[index].steps,
    actualMs: actual,
    wallMs: Number(turns[index].ms) || 0,
    targetMs: Math.round(target),
    ceilingMs: ceiling === null ? null : Math.round(ceiling),
    medianMs: median === null ? null : Math.round(median),
    p75Ms: p75 === null ? null : Math.round(p75),
    ratio: target > 0 ? Number((actual / target).toFixed(2)) : null,
    verdict,
  });
}

const count = (name) => rows.filter((r) => r.verdict === name).length;
const rate = (n) => (rows.length === 0 ? 0 : Number(((n / rows.length) * 100).toFixed(1)));
// 「提前超预估」＝界面说了「超预估」，但实际时长其实还在 p75 以内。三阶段方案下构造上为 0。
const premature = rows.filter((r) => r.verdict === 'overrun' && r.ceilingMs !== null && r.actualMs <= r.ceilingMs).length;
const summary = {
  store: STORE,
  turns: turns.length,
  duplicatesDropped: dropped,
  ok: count('ok'),
  extended: count('extended'),
  overrun: count('overrun'),
  extendedRate: rate(count('extended')),
  overrunRate: rate(count('overrun')),
  premature,
  prematureRate: rate(premature),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
  console.log(`样本 ${summary.turns} 回合（去掉重复 ${summary.duplicatesDropped} 条）`);
  console.log(`ok ${summary.ok} / 最多约 ${summary.extended}（${summary.extendedRate}%）/ 超预估 ${summary.overrun}（${summary.overrunRate}%）`);
  console.log(`提前超预估 ${summary.premature} 轮（${summary.prematureRate}%）——这一项应为 0`);
  console.log('');
  console.log('回合  产出    步数   实际    中位    p75      比值  判定');
  for (const row of rows) {
    const mmss = (ms) => (ms === null ? '-' : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`);
    console.log(
      `${String(row.turn).padStart(4)}  ${String(row.tokens).padStart(6)}  ${String(row.steps).padStart(4)}  `
      + `${mmss(row.actualMs).padStart(7)}  ${mmss(row.targetMs).padStart(6)}  ${mmss(row.p75Ms).padStart(7)}  `
      + `${String(row.ratio ?? '-').padStart(5)}  ${row.verdict}`,
    );
  }
  const bad = rows.filter((r) => r.verdict === 'overrun' && r.ceilingMs !== null && r.actualMs <= r.ceilingMs);
  if (bad.length > 0) {
    console.log('');
    console.log('过早案例（时长还在历史 p75 以内就喊超预估）：');
    for (const row of bad) {
      console.log(`  #${row.turn} 实际 ${(row.actualMs / 1000).toFixed(0)}s / 预估 ${(row.targetMs / 1000).toFixed(0)}s = ${row.ratio}×`);
    }
  }
}
