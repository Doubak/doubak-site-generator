#!/usr/bin/env node
/**
 * 把构建好的站点铺进一个**已存在的仓库目录**，让 GitHub Pages 能直接发布。
 *
 *   node bin/deploy.js <canonical 目录> <bundle 目录> <仓库目录> [--dry-run]
 *
 * ## 为什么不能直接推产出目录
 *
 * `npm run site` 产出的是一个 **Hugo 工程**：`content/` `layouts/` `hugo.toml`
 * `static/` `public/`。而 GitHub Pages 发布的是**仓库根**——推上去它会在根目录
 * 找 `index.html`，找不到。要发布的其实只是 `public/` 里的东西。
 *
 * 所以这一步做的是：构建，然后把 `public/` 的内容平铺到仓库根，顺带
 *
 *   - 写一个 `.nojekyll`。不写的话 GitHub 会拿 Jekyll 再处理一遍，
 *     而下划线开头的路径会被它**静默吞掉**（现在没有，但这不该靠运气）。
 *   - 保住 `CNAME`、`LICENSE`、`README.md`、`.git`——它们是仓库的东西，不是站点的。
 *   - 删掉上一次部署留下、这次不该再有的文件。**不删的话会留下幽灵页面**：
 *     有固定链接、能打开、内容看着正常，只是早就不在数据里了。
 *
 * ## 先看清楚要公开什么
 *
 * 这一步是**把私人档案变成公开网页**，而且不可逆——推出去就被抓取、被缓存了。
 * 所以默认先把「会公开什么」摆出来，`--dry-run` 只看不写。
 */

import {
  existsSync, readdirSync, statSync, cpSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/generate.js';
import { ensureHugo } from '../src/hugo-bin.js';
import { readCanonical } from '../src/canonical.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [canonDir, bundlesDir, repoDir] = args.filter((a) => !a.startsWith('--'));

if (!canonDir || !bundlesDir || !repoDir) {
  console.error('用法: node bin/deploy.js <canonical 目录> <bundle 目录> <仓库目录> [--dry-run]');
  process.exit(2);
}
if (!existsSync(repoDir)) {
  // **不新建。** 目标该是一个已经存在的、有 .git 的仓库；自动创建只会让
  // 打错一个路径变成「往某个空目录里倒了 3000 个文件」。
  console.error(`${repoDir} 不存在。请先 clone 那个仓库。`);
  process.exit(1);
}

/** 仓库自己的东西，不属于站点，任何时候都不动。 */
const KEEP = new Set(['.git', '.gitignore', 'CNAME', 'LICENSE', 'README.md', '.github']);

// ── ① 构建到一个暂存目录（不是仓库目录——构建中途失败不该把仓库搞成半成品）
const stage = join(HERE, '..', '.deploy-stage');
rmSync(stage, { recursive: true, force: true });

const t0 = Date.now();
const r = generate({
  canonical: readCanonical(canonDir),
  bundlesDir,
  outDir: stage,
  themeDir: join(HERE, '..', 'theme', 'hugo'),
});
console.log(`① 生成 ${r.pages} 页 · 图片 ${r.images.written} 张 · ${Date.now() - t0} ms`);

const { path: hugo } = await ensureHugo({ cacheDir: join(HERE, '..', '.hugo'), log: (m) => console.log(`   ${m}`) });
const built = spawnSync(hugo, ['--quiet'], { cwd: stage, stdio: 'inherit' });
if (built.status !== 0) {
  console.error('Hugo 构建失败，仓库目录一个字都没动。');
  process.exit(built.status ?? 1);
}
const publicDir = join(stage, 'public');
console.log('② 构建完成');

// ── ② 摆出来：要公开什么
const files = walk(publicDir);
const byKind = {};
for (const f of files) {
  const k = /\.(jpg|jpeg|png|gif|webp)$/i.test(f) ? '图片' : /\.html$/i.test(f) ? '页面' : '其他';
  byKind[k] = (byKind[k] ?? 0) + 1;
}
const bytes = files.reduce((n, f) => n + statSync(join(publicDir, f)).size, 0);

console.log('\n③ 这次会公开：');
for (const [k, n] of Object.entries(byKind)) console.log(`   ${k} ${n}`);
console.log(`   合计 ${(bytes / 1024 / 1024).toFixed(1)} MB → ${resolve(repoDir)}`);

const stale = readdirSync(repoDir).filter((n) => !KEEP.has(n));
if (stale.length) {
  console.log(`\n   会先清掉仓库里上一次留下的 ${stale.length} 项：${stale.slice(0, 6).join(' ')}${stale.length > 6 ? ' …' : ''}`);
  console.log(`   保留：${[...KEEP].filter((n) => existsSync(join(repoDir, n))).join(' ')}`);
}

if (dryRun) {
  console.log('\n--dry-run：什么都没写。');
  process.exit(0);
}

// ── ③ 铺进仓库
for (const n of stale) rmSync(join(repoDir, n), { recursive: true, force: true });
for (const n of readdirSync(publicDir)) {
  cpSync(join(publicDir, n), join(repoDir, n), { recursive: true });
}
// Jekyll 会静默吞掉下划线开头的路径。现在没有，但这不该靠运气。
writeFileSync(join(repoDir, '.nojekyll'), '');
rmSync(stage, { recursive: true, force: true });

console.log(`\n④ 铺好了。仓库目录已就绪，`
  + `\n   git -C ${repoDir} add -A && git -C ${repoDir} commit && git -C ${repoDir} push`);

/** 列出目录下所有文件的相对路径。 */
function walk(root, prefix = '') {
  const out = [];
  for (const n of readdirSync(join(root, prefix))) {
    const rel = prefix ? join(prefix, n) : n;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}
