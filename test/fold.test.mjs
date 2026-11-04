/**
 * Fold spec for the `turnEta` unit: run a synthetic turn through
 * `init` → `apply` and assert the wall-clock, token, and history figures.
 * Run with `node test/fold.test.mjs` from the package root.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离持久化：不给临时路径的话，init() 会从上次跑测试留下的 history.json 里种历史。
process.env.DSH_TURN_ETA_STORE = join(tmpdir(), `turn-eta-fold-${process.pid}.json`);
rmSync(process.env.DSH_TURN_ETA_STORE, { force: true });
const { turnEtaProjectionDefinition: def } = await import('../lib/index.js');

const events = [
  { type: 'turn/start', time: 1000, data: { turn: 1 } },
  { type: 'step/start', time: 1000, data: { turn: 1, step: 1 } },
  { type: 'assistant/attempt', time: 1100, data: { turn: 1, step: 1, stream: {} } },
  { type: 'assistant/message', time: 3000, data: { usage: { outputTokens: 500 } } },
  { type: 'step/end', time: 3000, data: { turn: 1, step: 1 } },
  { type: 'tool/call', time: 3000, data: { callId: 'c1' } },
  { type: 'tool/result', time: 5000, data: { message: { source: { callId: 'c1' } } } },
  { type: 'step/start', time: 5000, data: { turn: 1, step: 2 } },
  { type: 'assistant/message', time: 7000, data: { usage: { outputTokens: 300 } } },
  { type: 'assistant/message', time: 7500, data: { usage: {} } },
  { type: 'step/end', time: 7500, data: { turn: 1, step: 2 } },
  { type: 'turn/end', time: 8000, data: { turn: 1 } },
];

let state = def.init();
for (const event of events) state = def.apply(state, event);
const view = def.wire.view(state);
console.log('view:', JSON.stringify(view));

const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};
expect(view.tokens === 800, `tokens=${view.tokens} expected 800`);
expect(view.toolMs === 2000, `toolMs=${view.toolMs} expected 2000`);
expect(view.llmMs === 4500, `llmMs=${view.llmMs} expected 4500`);
expect(view.steps === 2, `steps=${view.steps} expected 2`);
expect(view.start === 1000 && view.end === 8000, 'turn boundaries wrong');
expect(view.history.length === 1 && view.history[0].tokens === 800 && view.history[0].ms === 7000, 'history wrong');
expect(view.toolBusy === false, 'toolBusy should be false after the result');

// A live turn: no end, tool open, history carried over from the finished turn.
let live = def.apply(state, { type: 'turn/start', time: 20000, data: { turn: 2 } });
live = def.apply(live, { type: 'step/start', time: 20000, data: { turn: 2, step: 1 } });
live = def.apply(live, { type: 'assistant/message', time: 22000, data: { usage: { outputTokens: 120 } } });
live = def.apply(live, { type: 'tool/call', time: 22000, data: { callId: 'c2' } });
const liveView = def.wire.view(live);
console.log('live:', JSON.stringify(liveView));
expect(liveView.end === null, 'live turn must have no end');
expect(liveView.toolBusy === true, 'live turn must report the open tool');
expect(liveView.tokens === 120 && liveView.llmMs === 2000, 'live figures wrong');
expect(liveView.history.length === 1, 'history must survive a turn/start');

console.log(problems.length === 0 ? 'FOLD_OK' : `FOLD_FAIL ${problems.join('; ')}`);
process.exitCode = problems.length === 0 ? 0 : 1;
