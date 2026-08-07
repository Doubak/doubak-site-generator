#!/usr/bin/env node
/**
 * canonical + bundle → 静态站源目录。**不联网。**
 *
 *   node bin/generate.js <canonical 目录> <bundle 目录> [产出目录]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from '../src/generate.js';

const [canonDir, bundlesDir, outDir = 'site-out'] = process.argv.slice(2);
if (!canonDir) {
  console.error('用法: node bin/generate.js <canonical 目录> <bundle 目录> [产出目录]');
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
  },
  bundlesDir,
  outDir,
});

console.log(`页面 ${r.pages}（标记 ${r.marks} · 长文 ${r.longform}）· 图片 ${r.images.written} 张 · ${Date.now() - t0} ms → ${outDir}/`);

// **缺图要说出来。** 静默忽略的话，站点上会缺一张图而没人知道为什么——
// 而原因（那次抓取被拦下了／那条路线还没做）恰恰是用户该知道的。
if (r.images.missing.length) {
  console.log(`\n档案里没有的图 ${r.images.missing.length} 张（页面上会缺）：`);
  for (const u of r.images.missing.slice(0, 5)) console.log('  ', u);
  if (r.images.missing.length > 5) console.log(`   …另有 ${r.images.missing.length - 5} 张`);
}
