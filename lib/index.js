/**
 * The `turnEta` projection unit: a pure fold of one turn's wall clock and
 * produced tokens, served through the session-projection seam so the client
 * can render "this reply has been running mm:ss and produced N tokens" from
 * real numbers, with the remaining time clearly marked as an estimate.
 *
 * `sessionStats` already folds whole-session totals, but it deliberately
 * drops turn boundaries (`turn/start` records nothing, `turn/end` only clears
 * pending calls). This unit keeps exactly those boundaries plus the token
 * count of the open turn, and a small history of finished turns so the client
 * can estimate how long a reply of the same size usually takes.
 *
 * @module dsh-turn-eta
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Cordis plugin name. */
export const name = 'turn-eta';

/** The projection registry is the plugin's whole purpose. */
export const inject = ['sessionProjections'];

/** How many finished turns the fold keeps (the client medians over the last 8). */
const HISTORY_LIMIT = 40;

/**
 * Cross-session memory of finished turns. Without it every new session starts
 * with an empty history and the estimate cannot appear until the second turn.
 */
// 测试用 DSH_TURN_ETA_STORE 指到临时文件，避免种子历史污染断言
const STORE_FILE = process.env.DSH_TURN_ETA_STORE || join(homedir(), '.dsh', 'storages', 'dsh-turn-eta', 'history.json');

/** @returns {Array<{tokens:number, ms:number}>} persisted turns, newest last. */
function readStoredHistory() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    const turns = Array.isArray(parsed?.turns) ? parsed.turns : [];
    return turns
      .filter((t) => Number.isFinite(t?.tokens) && t.tokens > 0 && Number.isFinite(t?.ms) && t.ms > 0)
      .map((t) => ({
        tokens: t.tokens,
        ms: t.ms,
        steps: Number.isFinite(t?.steps) ? t.steps : null,
        toolMs: Number.isFinite(t?.toolMs) ? t.toolMs : null,
        llmMs: Number.isFinite(t?.llmMs) ? t.llmMs : null,
      }))
      .slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Best-effort persistence: a failed write must never break event folding. */
function writeStoredHistory(history) {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify({ version: 1, updatedAt: Date.now(), turns: history }, null, 0));
  } catch {
    /* ignore */
  }
}

/**
 * 单价来源，优先级从高到低：
 *   1. ~/.dsh/storages/dsh-turn-eta/config.json —— 用户自己覆盖（可选，装完才有）
 *   2. ~/.dsh/storages/cost-meter/ledger.json —— 装了 cost-meter 的机器直接用它的实时价
 *   3. DEFAULT_PRICING —— 内置默认价，保证换台机器也不至于整行空白
 */
const PRICE_FILE = join(homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json');
const CONFIG_FILE = join(homedir(), '.dsh', 'storages', 'dsh-turn-eta', 'config.json');
const PRICE_MODEL = process.env.DSH_TURN_ETA_MODEL || 'deepseek-flash';

/** USD / 1M token。改价只需改这里，或者写一个 config.json 覆盖。 */
const DEFAULT_PRICING = {
  symbol: '¥',
  currency: 'CNY',
  exchangeRate: 7.2,
  peakEnabled: true,
  peakWindows: [
    { start: 1, end: 4 },
    { start: 6, end: 10 },
  ],
  prices: {
    models: {
      'deepseek-flash': { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6, peak: { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 } },
      'deepseek-v4-flash': { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6, peak: { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 } },
    },
  },
};

/**
 * @returns {null | {symbol:string, currency:string, fx:number, hasPeak:boolean,
 *   peakEnabled:boolean, peakWindows:Array<{start:number,end:number}>,
 *   offPeak:{miss:number,hit:number,out:number}, peak:{miss:number,hit:number,out:number}}}
 *   USD per million tokens, plus the CNY conversion the ledger already uses.
 */
/** Read one JSON file, or null when it is missing / broken. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The price entry for `model`, from a ledger-shaped config, a flat
 * `{prices: {cacheMiss, cacheHit, output}}` override, or a `{models: {...}}` map.
 */
function pickEntry(config, model) {
  if (typeof config !== 'object' || config === null) return null;
  const prices = config.prices;
  if (typeof prices === 'object' && prices !== null && prices.cacheMiss !== undefined) return prices;
  const models = prices?.models ?? config.models;
  if (typeof models !== 'object' || models === null) return null;
  const entry = models[model] ?? models['deepseek-flash'] ?? models['deepseek-v4-flash'] ?? models.default;
  return typeof entry === 'object' && entry !== null ? entry : null;
}

function readPricing() {
  const override = readJson(CONFIG_FILE);
  const ledger = readJson(PRICE_FILE)?.config ?? null;
  const model = process.env.DSH_TURN_ETA_MODEL || override?.model || PRICE_MODEL;
  const sources = [override, ledger, DEFAULT_PRICING].filter((source) => typeof source === 'object' && source !== null);
  const entry = sources.map((source) => pickEntry(source, model)).find((found) => found !== null) ?? null;
  if (entry === null) return null;

  /** First source that defines `field`, so an override can pin just one knob. */
  const first = (pick) => {
    for (const source of sources) {
      const value = pick(source);
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };

  const bucket = (from, fallback) => ({
    miss: Number(from?.cacheMiss ?? fallback?.cacheMiss),
    hit: Number(from?.cacheHit ?? fallback?.cacheHit),
    out: Number(from?.output ?? fallback?.output),
  });
  const offPeak = bucket(entry.offPeak ?? entry, entry);
  const peak = bucket(entry.peak ?? entry, offPeak);
  const windows = first((source) => source.peakWindows);
  const holidays = first((source) => source.peakHolidays);
  const effectiveAt = first((source) => source.peakEffectiveAt);
  const schedule = first((source) => source.peakSchedule);
  const fx = first((source) => source.exchangeRate);
  return {
    symbol: first((source) => (typeof source.symbol === 'string' ? source.symbol : undefined)) ?? '¥',
    currency: first((source) => (typeof source.currency === 'string' ? source.currency : undefined)) ?? 'CNY',
    fx: Number.isFinite(fx) && fx > 0 ? fx : 7.2,
    hasPeak: entry.peak !== undefined,
    peakEnabled: first((source) => source.peakEnabled) !== false,
    peakWindows: Array.isArray(windows)
      ? windows
          .filter((w) => Number.isFinite(w?.start) && Number.isFinite(w?.end))
          .map((w) => ({ start: w.start, end: w.end }))
      : [],
    // 峰谷日历：周末与节假日按北京时间算，窗口本身是 UTC 小时。
    peakSchedule: typeof schedule === 'string' ? schedule : 'deepseek',
    peakHolidays: Array.isArray(holidays)
      ? holidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
      : [],
    peakEffectiveAt: typeof effectiveAt === 'string' ? effectiveAt : null,
    offPeak,
    peak,
  };
}

let pricingCache = null;
let pricingCachedAt = 0;

/** The ledger is re-read at most once a minute: prices rarely move. */
function pricing() {
  if (Date.now() - pricingCachedAt > 60000) {
    pricingCache = readPricing();
    pricingCachedAt = Date.now();
  }
  return pricingCache;
}

/**
 * A schema stand-in: the projection registry only calls `.parse(value)` on
 * persisted rows and on the wire view, so a plain validating pass-through is
 * enough and keeps this plugin free of a zod dependency.
 */
const passThrough = { parse: (value) => value };

/** Fold state: totals of the current turn plus the in-flight boundaries. */
const initialState = () => ({
  turn: 0,
  start: null,
  end: null,
  steps: 0,
  tokens: 0,
  llmMs: 0,
  toolMs: 0,
  contextTokens: null,
  openStep: null,
  pendingCalls: {},
  history: [],
});

/**
 * Provider-reported completion tokens, guarded the way the window fold guards
 * node usage.
 * @param usage - the assistant/message event's optional usage record.
 * @returns the output-token count, or null when unreported or invalid.
 */
function usageOutputTokens(usage) {
  if (typeof usage === 'object' && usage !== null) {
    const value = usage.outputTokens;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Prompt-side tokens of the last reply: the size of the context the next turn
 * will resend, and therefore the input half of the pre-send estimate.
 * @param usage - the assistant/message event's optional usage record.
 * @returns the input-token count, or null when unreported or invalid.
 */
function usageInputTokens(usage) {
  if (typeof usage !== 'object' || usage === null) return null;
  const value = usage.inputTokens ?? usage.promptTokens ?? usage.totalInputTokens;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const cached = usage.cachedInputTokens ?? usage.cachedTokens ?? usage.cacheReadTokens;
  // `inputTokens` only counts the uncached prompt: the context the next turn
  // resends is fresh + cached, so the total has to add the cache read back in.
  return Number.isFinite(cached) && cached > 0
    ? { total: value + cached, cached, fresh: value }
    : { total: value, cached: 0, fresh: value };
}

/** @param state - fold state. @returns the wire view served to clients. */
function viewOf(state) {
  return {
    turn: state.turn,
    start: state.start,
    end: state.end,
    steps: state.steps,
    tokens: state.tokens,
    llmMs: state.llmMs,
    toolMs: state.toolMs,
    contextTokens: state.contextTokens,
    history: state.history,
    pricing: pricing(),
    toolBusy: Object.keys(state.pendingCalls).length > 0,
  };
}

/** The `turnEta` unit registered on `ctx.sessionProjections`. */
export const turnEtaProjectionDefinition = {
  key: 'turnEta',
  stateVersion: 1,
  stateSchema: passThrough,
  init: () => ({ ...initialState(), history: readStoredHistory() }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return {
          ...initialState(),
          turn: event.data.turn,
          start: event.time,
          history: state.history,
          contextTokens: state.contextTokens,
        };
      case 'step/start':
        return {
          ...state,
          openStep: {
            turn: event.data.turn,
            step: event.data.step,
            startTime: event.time,
            lastAt: null,
          },
        };
      case 'assistant/message': {
        const open = state.openStep;
        const contextTokens = usageInputTokens(event.data.usage) ?? state.contextTokens;
        if (open === null) return { ...state, contextTokens };
        const since = open.lastAt ?? open.startTime;
        const outputTokens = usageOutputTokens(event.data.usage) ?? 0;
        return {
          ...state,
          tokens: state.tokens + outputTokens,
          llmMs: state.llmMs + Math.max(0, event.time - since),
          contextTokens,
          openStep: { ...open, lastAt: event.time },
        };
      }
      case 'tool/call': {
        const callId = event.data.callId;
        if (typeof callId !== 'string') return state;
        return {
          ...state,
          pendingCalls: { ...state.pendingCalls, [callId]: event.time },
        };
      }
      case 'tool/result': {
        const callId = event.data.message?.source?.callId;
        if (typeof callId !== 'string' || !Object.hasOwn(state.pendingCalls, callId)) return state;
        const pendingCalls = { ...state.pendingCalls };
        const dispatched = pendingCalls[callId];
        delete pendingCalls[callId];
        return {
          ...state,
          toolMs: state.toolMs + Math.max(0, event.time - dispatched),
          pendingCalls,
        };
      }
      case 'step/end':
        return { ...state, steps: state.steps + 1, openStep: null };
      case 'turn/end': {
        const recorded =
          state.start === null || state.tokens <= 0
            ? state.history
            : [
                ...state.history,
                {
                  tokens: state.tokens,
                  ms: Math.max(0, event.time - state.start),
                  steps: state.steps,
                  toolMs: state.toolMs,
                  llmMs: state.llmMs,
                },
              ].slice(-HISTORY_LIMIT);
        if (recorded !== state.history) writeStoredHistory(recorded);
        return { ...state, end: event.time, openStep: null, pendingCalls: {}, history: recorded };
      }
      default:
        return state;
    }
  },
  wire: { viewSchema: passThrough, view: viewOf },
};

/**
 * Register the `turnEta` unit; the registration is an effect on this plugin's
 * fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(turnEtaProjectionDefinition);
}
