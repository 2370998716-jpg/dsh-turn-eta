#!/usr/bin/env node
/**
 * 生成插件市场索引 `index.json`（插件市场索引格式 1）。
 *
 * 用法：
 *   node scripts/build-index.mjs
 *   node scripts/build-index.mjs --repo https://github.com/<你的用户名>/dsh-turn-eta
 *
 * 提交号取自当前 HEAD，所以**必须先生成 commit、再跑这个脚本**；
 * 之后把同一个 commit push 上去，索引里钉的 SHA 就不会变。
 * 改用户名/仓库地址只需要重跑一次，不用手改 JSON。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  const prefixed = process.argv.find(a => a.startsWith(`--${name}=`))
  return prefixed ? prefixed.slice(name.length + 3) : undefined
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

let repoUrl = argValue('repo') ?? pkg.repository?.url
if (!repoUrl) {
  console.error('✗ package.json 里没有 repository.url，用 --repo 指定一个 https 仓库地址')
  process.exit(1)
}
repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '')

let commit
try {
  commit = argValue('commit') ?? git('rev-parse', 'HEAD')
} catch {
  console.error('✗ 当前目录还不是 git 仓库（或者还没有 commit）。先 git init / git commit。')
  process.exit(1)
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`✗ 不是 40 位十六进制 SHA：${commit}`)
  process.exit(1)
}

const publishTimestamp = Number(git('log', '-1', '--format=%ct', commit))
if (!Number.isInteger(publishTimestamp)) {
  console.error('✗ 拿不到 commit 时间戳')
  process.exit(1)
}

const index = {
  format: 1,
  title: { en: 'dsh plugins by zuo', zh: '我做的 DSH 插件' },
  description: {
    en: 'Small, self-contained DeepSeek Harness plugins.',
    zh: '一些自用的 DeepSeek Harness 小插件。',
  },
  metadata: {
    categories: {
      ui: { title: { en: 'Interface', zh: '界面' } },
    },
    labels: {
      timing: { title: { en: 'Timing', zh: '耗时' } },
      cost: { title: { en: 'Cost', zh: '费用' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Turn ETA (turn timing + cost estimate)', zh: '轮次耗时与费用预估' },
      description: {
        en: 'Turn timing, token count, speed and a self-calibrating countdown in the conversation header, plus a pre-send estimate of output tokens, cost and duration.',
        zh: pkg.description,
      },
      author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
      homepage: pkg.homepage,
      repository: { url: repoUrl },
      metadata: {
        category: 'ui',
        keywords: pkg.keywords ?? [],
        labels: ['timing', 'cost'],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: { type: 'git', url: repoUrl, commit },
          engines: {},
        },
      ],
    },
  ],
}

const out = resolve(root, 'index.json')
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

console.log(`✓ 写好 ${out}`)
console.log(`  ${pkg.name}@${pkg.version}`)
console.log(`  git ${repoUrl} @ ${commit}`)
console.log('  市场里加这个索引地址：')
console.log(`  ${repoUrl.replace('github.com', 'raw.githubusercontent.com')}/main/index.json`)
