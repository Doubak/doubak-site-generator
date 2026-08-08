#!/usr/bin/env node
/**
 * canonical + bundle → 静态站源目录。**不联网。**
 *
 *   node bin/generate.js <canonical 目录> <bundle 目录> [产出目录]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/generate.js';

const args = process.argv.slice(2);
// **默认带上那个最小 Hugo 骨架**，让产出目录直接能跑起来。
// 不想要（比如要换成现成的主题）就 --no-theme。
const withTheme = !args.includes('--no-theme');
const [canonDir, bundlesDir, outDir = 'site-out'] = args.filter((a) => !a.startsWith('--'));
if (!canonDir) {
  console.error('用法: node bin/generate.js <canonical 目录> <bundle 目录> [产出目录] [--no-theme]');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));

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
  themeDir: withTheme ? join(HERE, '..', 'theme', 'hugo') : null,
});

console.log(
  `页面 ${r.pages}（标记 ${r.marks} · 长文 ${r.longform} · 广播 ${r.broadcasts} 条归入 ${r.broadcastMonths} 个月）`
  + ` · 图片 ${r.images.written} 张 · ${Date.now() - t0} ms → ${outDir}/`,
);

// **缺图要说出来。** 静默忽略的话，站点上会缺一张图而没人知道为什么——
// 而原因（那次抓取被拦下了／那条路线还没做）恰恰是用户该知道的。
if (r.theme) {
  console.log(`\n带上了那个最小 Hugo 骨架。装了 hugo 的话现在就能看：`);
  console.log(`   cd ${outDir} && hugo server`);
  console.log('   骨架只是个起点——删掉 layouts/ 换任何一个现成主题，content/ 与 static/ 一个字都不用动。');
}

if (r.images.missing.length) {
  console.log(`\n档案里没有的图 ${r.images.missing.length} 张（页面上会缺）：`);
  for (const u of r.images.missing.slice(0, 5)) console.log('  ', u);
  if (r.images.missing.length > 5) console.log(`   …另有 ${r.images.missing.length - 5} 张`);
}
