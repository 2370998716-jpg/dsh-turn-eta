# dsh-turn-eta

给 DSH 加两个东西：

1. **对话头部**实时显示本轮耗时、消耗 token、速度、是否在跑工具，以及**剩余时间倒计时**（只减不增）。
2. **输入框下方**发送前预估：这一轮大概会产出多少 token、按单价折算多少钱（≈¥）、预计要跑多久。

自带默认单价，不依赖 cost-meter 插件也能显示 `≈¥`。纯文字、无进度条、无动效。

## 安装

需要 Node.js ≥ 22.19（DSH 自带，一般不用管）。下面三种方式选一种。

### 方式一：从仓库直接装（最稳）

```
dsh plugin --profile <profile> add git+https://github.com/2370998716-jpg/dsh-turn-eta.git
```

`<profile>` 换成你正在用的 profile，桌面版一般是 `desktop`，Web 版是 `web`。

Windows 上如果 `dsh` 不在 PATH 里，用完整路径：

```
cmd /c ""C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add git+https://github.com/2370998716-jpg/dsh-turn-eta.git"
```

### 方式二：从本地文件夹

1. 把整个仓库文件夹放到任意位置（路径别带奇怪的符号）。
2. 在终端执行：

```
dsh plugin --profile <profile> add "<上面那个文件夹的绝对路径>"
```

### 方式三：从自定义索引源（要你的 DSH 有「发现」页）

DSH 0.2.1 起，插件页如果有 **发现** 标签，可以在索引源里添加：

```
https://raw.githubusercontent.com/2370998716-jpg/dsh-turn-eta/main/index.json
```

列表里会出现「轮次耗时与费用预估」。**没有「发现」标签的装法用方式一**，一样能装。

### 装完

**完全退出 DSH 再打开**（不是刷新页面）。宿主侧代码只在启动时加载，不重启看不到 `≈¥`。

打开任意对话，头部应该出现 `⏱ 0:03 · 120 tok · 60 tok/s · 估约 1:37`，输入框上方应该出现 `⚖ 预计 3.2k tok 产出 · 上下文 60k · ≈¥0.016 · ~0:22`。

第一条消息发出去之后，单轮统计才开始累计；预估会随历史轮次增加而变准。

## 改价格 / 换模型

默认按 DeepSeek 的 token 单价（美元／百万 token）：

| 模型 | 缓存未命中 | 缓存命中 | 输出 |
| --- | --- | --- | --- |
| deepseek-flash / deepseek-v4-flash | 0.15 | 0.003 | 0.6 |
| 高峰时段（1–4 点、6–10 点 UTC） | 翻倍 | | |

汇率默认 `7.2`。想改就新建：

`~/.dsh/storages/dsh-turn-eta/config.json`（Windows 是 `C:\Users\<你>\.dsh\storages\dsh-turn-eta\config.json`）

```json
{
  "model": "deepseek-flash",
  "currency": "CNY",
  "symbol": "¥",
  "exchangeRate": 7.2,
  "peakEnabled": true,
  "peakWindows": [{ "start": 1, "end": 4 }, { "start": 6, "end": 10 }],
  "prices": { "cacheMiss": 0.15, "cacheHit": 0.003, "output": 0.6 }
}
```

- `prices` 可以直接写扁平的单价（上面这样），也可以写完整结构 `{ "models": { "deepseek-flash": { "cacheMiss": …, "cacheHit": …, "output": …, "peak": { … } } } }`。
- 只写想改的字段就行，没写的自动落回默认值。
- 改完**不用重启**，等最多 60 秒（价格有 1 分钟缓存）。

**价格来源优先级**：`config.json` 覆盖 → `~/.dsh/storages/cost-meter/ledger.json`（装了 cost-meter 那个插件时会读它的真实账单单价）→ 内置默认。所以装了 cost-meter 的机器会自动用真实单价，没装的机器用内置。

## 卸载

```
dsh plugin --profile <profile> remove dsh-turn-eta
```

然后重启 DSH。

## 说明

- 倒计时用的是「这一轮大概产出多少 token」的历史中位数，再按速度折算；同一轮内目标值会锁死，所以数字只会往下走，工具跑久了也不会往回跳。
- **跑超了只补一次跑道**：到点时如果这一轮还没结束，倒计时不会停在「快完了」装作快好，而是按历史步长再给 2–15 秒，并把超出时长的一部分（25%，上限 15 秒）一起补进去。补过一次还没结束，就改成显示「超预估」——不再给第二个数字。补一步是诚实的，补第二次就是编。
- **挂机不算数**：某一轮墙钟时间远大于真实干活时间（模型 + 工具，2 倍以上且多 20 秒）时，按真实干活时间记样本，避免一次挂机把之后所有预估拉长。单个离群样本也会被压回中位数的 8 倍以内。
- 鼠标悬停能看到 `p25–p75` 的历史区间——那是「快慢两种轮次各占到什么位置」，头部只显示一个干净的数。
- 历史记录存在 `~/.dsh/storages/dsh-turn-eta/history.json`，删掉就重新开始学。
- 环境变量 `DSH_TURN_ETA_MODEL` 可以临时换用哪个模型的单价。

## 开发

```
npm test       # 纯函数单测（折叠逻辑 + 倒计时/离群/区间/计价）
npm run test:sim   # 用假 React 跑一遍真实渲染，打印各场景文本
```

`lib/client.js` 是 `window.__ModuleLoader__` bundle，不能 `import`，所以纯函数通过 `exports.__internals` 暴露给测试。

## English

Two additions to DeepSeek Harness, rendered as plain inline text (no progress bar, no animation):

1. **Session header**: elapsed time of the current turn, tokens produced, tokens/s, whether a tool is running, and a **remaining-time countdown** that only ever decreases.
2. **Above the composer**: a pre-send estimate — how many output tokens this turn will probably produce, what it will cost at the configured per-token price (≈¥ by default), and roughly how long it will take.

Default prices are built in, so `≈¥` works without any companion plugin.

- Countdown never stalls: when a turn outlives its estimate, the plugin grants a fresh 2–15 s runway (plus 25% of the overshoot, capped at 15 s) instead of freezing on "almost done".
- Idle time is filtered out: a turn whose wall-clock time is more than 2× its real model + tool time is sampled at the real time, and single outliers are winsorised at 8× the median duration.
- Hover the header chip for the `p25–p75` historical interval; the chip itself stays a single number.
- History lives in `~/.dsh/storages/dsh-turn-eta/history.json`; delete it to relearn from scratch.
- Override prices in `~/.dsh/storages/dsh-turn-eta/config.json`; `DSH_TURN_ETA_MODEL` picks a different price table.

```
npm test           # pure-function unit tests
npm run test:sim   # renders the real components against a fake React
```

## 反馈

用着有问题、有想法、发现数字算错了，都欢迎直接发邮件：

**2370998716@qq.com**

写清楚「DSH 版本 + 你在哪个界面看到的什么数字不对」就够，不用客气。也可以去 [GitHub Issues](https://github.com/2370998716-jpg/dsh-turn-eta/issues) 提。

## License

MIT © 2026 zuo
