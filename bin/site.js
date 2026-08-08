#!/usr/bin/env node
/**
 * 一条命令：canonical + bundle → 能打开的 HTML。**不联网**（除了第一次可能要下 Hugo）。
 *
 *   npm run site  -- <canonical 目录> <bundle 目录> [产出目录]
 *   npm run serve -- <canonical 目录> <bundle 目录> [产出目录]
 *
 * 与 `bin/generate.js` 的分工：那个只出 Markdown，这个再往下走一步把 HTML 也构建
 * 出来。分成两个是因为**只要 Markdown 的人是多数**——他们要换主题、要塞进已有的站点。
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/generate.js';
import { ensureHugo } from '../src/hugo-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const serve = args.includes('--serve');
const noTheme = args.includes('--no-theme');
const [canonDir, bundlesDir, outDir = 'site-out'] = args.filter((a) => !a.startsWith('--'));

if (!canonDir) {
  console.error('用法: node bin/site.js <canonical 目录> <bundle 目录> [产出目录] [--serve] [--no-theme]');
  process.exit(2);
}
if (noTheme) {
  // 骨架带的就是 layouts/ 与 hugo.toml。没有它们 Hugo 无从构建——
  // 与其让 Hugo 报一句难懂的错，不如在这儿说清楚。
  console.error('--no-theme 与构建 HTML 冲突：没有 layouts/，Hugo 不知道怎么渲染。');
  console.error('要么去掉 --no-theme，要么用 bin/generate.js 只出 Markdown。');
  process.exit(2);
}

const read = (name) => {
  const p = join(canonDir, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const t0 = Date.now();
const r = generate({
  canonical: {
    marks: read('marks.ndjson'),
    subjects: read('subjects.ndjson'),
    longform: read('longform.ndjson'),
    broadcasts: read('broadcasts.ndjson'),
  },
  bundlesDir,
  outDir,
  themeDir: join(HERE, '..', 'theme', 'hugo'),
});

console.log(
  `① 生成 ${r.pages} 页（标记 ${r.marks} · 长文 ${r.longform} · 广播 ${r.broadcasts} 条归入 ${r.broadcastMonths} 个月）`
  + ` · 图片 ${r.images.written} 张 · ${Date.now() - t0} ms`,
);
console.log(`   搜索索引 ${r.searchRows} 条（${Math.round(r.searchBytes / 1024)} KB，gzip 后 ${Math.round(r.searchGzip / 1024)} KB）`);

if (r.images.missing.length) {
  console.log(`   档案里没有的图 ${r.images.missing.length} 张（页面上会缺）`);
}

const { path: hugo, source } = await ensureHugo({
  cacheDir: join(HERE, '..', '.hugo'),
  log: (m) => console.log(`   ${m}`),
});

console.log(`② ${serve ? '起预览' : '构建 HTML'}（hugo，来自${
  { cache: '缓存', path: 'PATH', download: '刚下载' }[source]}）…`);

// **在产出目录里跑 Hugo**，不是在这个仓库里——产出目录才是那个站点。
const child = spawn(hugo, serve ? ['server'] : [], {
  cwd: resolve(outDir),
  stdio: 'inherit',
});
child.on('exit', (code) => {
  if (code === 0 && !serve) {
    console.log(`\n好了：${resolve(outDir, 'public')}`);
    console.log('   直接用浏览器打开 public/index.html 就能看，不需要服务器。');
  }
  process.exit(code ?? 1);
});
