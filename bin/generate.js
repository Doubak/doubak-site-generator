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
import { readCanonical } from '../src/canonical.js';

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

const t0 = Date.now();
const r = generate({
  canonical: readCanonical(canonDir),
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
console.log(`   搜索索引 ${r.searchRows} 条（${Math.round(r.searchBytes / 1024)} KB，gzip 后 ${Math.round(r.searchGzip / 1024)} KB）`);

if (r.theme) {
  console.log(`\n带上了那个最小 Hugo 骨架。装了 hugo 的话现在就能看：`);
  console.log(`   cd ${outDir} && hugo server`);
  console.log('   骨架只是个起点——删掉 layouts/ 换任何一个现成主题，content/ 与 static/ 一个字都不用动。');
}

// **这一条不是「顺带提一句」。** 没导出到本地的图，页面上留的是 doubanio 的原始
// URL——它不会缺，它会去豆瓣取。也就是说这几张图从此需要豆瓣还活着才看得见，
// 而这个项目存在的全部理由就是不再需要那个前提。
//
// 原来这里写的是「页面上会缺」，那句话是错的，而且错得让人以为已经知道后果了。
// **档案里有、却取不出来的图。** 与「缺图」分开报，因为下一步动作正好相反：
// 缺的要重抓，读不出来的重抓没用——豆瓣那边好好的，坏的是手上这份档案。
//
// 这里不让整趟生成失败（页面全都出来了，只是少几张图，与「缺图」同级），
// 但**必须点名到捕获**：起因往往是某个 assets 段里几个字节坏了，而解析器
// 根本不打开图片行，所以它会一路安静地跑完——这条消息是整条链上唯一会提起
// 这件事的地方。
if (r.images.unreadable?.length) {
  console.log(`\n⚠ 有 ${r.images.unreadable.length} 张图在档案里，但取不出来（段文件那一段解压不开）：`);
  for (const u of r.images.unreadable.slice(0, 5)) {
    console.log(`   ${u.captureId}  ${u.url}`);
    console.log(`      ${u.dir}  —— ${u.error}`);
  }
  if (r.images.unreadable.length > 5) console.log(`   …另有 ${r.images.unreadable.length - 5} 张`);
  console.log('  这不是抓漏了，是这份档案的字节坏了。重抓没有用，要做的是：');
  console.log('    1. 拿原始拷贝重新解压 / 重新导入一次；');
  console.log('    2. 跑一遍完整性检查，看还有没有别的地方也坏了：');
  console.log('       node ../doubak-data-parser/bin/verify.js <bundle 目录>');
}

if (r.images.remote.length) {
  console.log(`\n⚠ 有 ${r.images.remote.length} 张图没能从档案里取到，页面上留的是 doubanio 的地址：`);
  for (const u of r.images.remote.slice(0, 5)) console.log('  ', u);
  if (r.images.remote.length > 5) console.log(`   …另有 ${r.images.remote.length - 5} 张`);
  console.log('  这几张要豆瓣还在才看得见。想补齐的话：重新抓一次，然后拿新档案再生成一遍。');
}
