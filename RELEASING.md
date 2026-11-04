# 发版步骤

这个仓库同时是「插件源码」和「插件市场的索引源」：`index.json` 放在仓库根，市场直接读
**<https://raw.githubusercontent.com/2370998716-jpg/dsh-turn-eta/main/index.json>**
（这一行就是「插件 → 发现 → 添加索引源」里要填的地址）。

## 一次性准备（已完成，留档备查）

仓库建在 **`https://github.com/2370998716-jpg/dsh-turn-eta`**（公开），远端 `origin` 已接好、
`main` 已跟踪 `origin/main`。当初的做法：

```bash
gh repo create dsh-turn-eta --public --source=. --remote=origin --push
```

⚠️ 这个账号名（`2370998716-jpg`）若是自动生成的，**改用户名会让上面的索引地址失效**；
真要改名就得把 `package.json` 的 `repository.url` / `homepage`、`README.md` 里的索引地址一起改，
重跑 `node scripts/build-index.mjs`，再推一次。

## 以后每次发版

```bash
# 1. 改代码、改 package.json 的 version
git add -A
git commit -m "feat: v1.1.0 —— 改了什么"

# 2. 用这个 commit 的 SHA 生成索引（先 commit 再生成，顺序不能反）
node scripts/build-index.mjs

# 3. 单独提交索引
git add index.json
git commit -m "chore: release 1.1.0"

# 4. 推
git push
```

`index.json` 里的 `versions` 是数组：**加新版本号时要把旧版本条目保留**，否则市场里回不到旧版本。
最简单的做法是每次把新的 `{version, publishTimestamp, source}` 对象 push 到 `versions` 数组**最前面**，
再跑一遍校验。

## 本地先校验一遍（可选，本机已就绪）

```bash
cd ../../../.tmp-market-check   # default-workspace/.tmp-market-check，校验器已装好
node check.mjs                  # 里面的路径和 URL 已按本仓库改好
```

从零装的话：

```bash
mkdir -p ../.tmp-market-check && cd ../.tmp-market-check
npm i @deepseek-ai/dsh-plugin-market-index
```

```js
// check.mjs
import { readFileSync } from 'node:fs'
import { parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'
const idx = parseMarketIndex(
  JSON.parse(readFileSync('../plugins/dsh-turn-eta-standalone/index.json', 'utf8')),
  'https://raw.githubusercontent.com/2370998716-jpg/dsh-turn-eta/main/index.json',
)
for (const p of idx.plugins) for (const v of p.versions) console.log(p.name, v.version, marketInstallTarget(p.name, v).spec)
```

跑 `node check.mjs`，没抛错就是合法的格式 1 索引。
