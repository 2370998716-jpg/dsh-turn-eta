# 发版步骤

这个仓库同时是「插件源码」和「插件市场的索引源」：`index.json` 放在仓库根，市场直接读
`https://raw.githubusercontent.com/<用户名>/dsh-turn-eta/main/index.json`。

## 一次性准备（只在第一次做）

1. 在 GitHub 建一个空仓库，名字 `dsh-turn-eta`，**不要**勾选 README / .gitignore / License。
2. 回到这个文件夹，把远端接上并推上去：

```bash
git remote add origin https://github.com/<用户名>/dsh-turn-eta.git
git push -u origin main
```

3. 如果用户名不是 `zuo`，改两处再重推（代码 commit 的 SHA 不变，只有 `index.json` 变）：

```bash
# package.json 里的 repository.url / homepage 改成新地址，然后：
node scripts/build-index.mjs --repo https://github.com/<用户名>/dsh-turn-eta --commit <代码 commit 的 SHA>
git add -A && git commit --amend --no-edit   # index.json 属于第二个 commit
git push
```

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

## 本地先校验一遍（可选）

```bash
mkdir -p ../.tmp-market-check && cd ../.tmp-market-check
npm i @deepseek-ai/dsh-plugin-market-index
```

```js
// check.mjs
import { readFileSync } from 'node:fs'
import { parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'
const idx = parseMarketIndex(
  JSON.parse(readFileSync('../dsh-turn-eta/index.json', 'utf8')),
  'https://raw.githubusercontent.com/<用户名>/dsh-turn-eta/main/index.json',
)
for (const p of idx.plugins) for (const v of p.versions) console.log(p.name, v.version, marketInstallTarget(p.name, v).spec)
```

跑 `node check.mjs`，没抛错就是合法的格式 1 索引。
