#!/usr/bin/env node
/**
 * 冒烟：用合成数据跑一遍完整生成，再把每份 front matter 读回来。
 *
 * ## 为什么单元测试不够
 *
 * 单元测试验的是「这个函数对不对」。这里验的是**整条链路拼起来对不对**：
 * canonical → 投影 → Markdown → 文件，任何一环把 YAML 写坏了，产出的都是
 * 一堆静态站生成器会当场报语法错误的文件，而报错会指着某个几千行文件里的
 * 某一行——用户根本无从判断是自己的短评还是工具的锅。
 *
 * ## 用合成数据，不用真实档案
 *
 * 真实档案是私人数据，不会进 CI。而这一条要验的性质与数据量无关，
 * 只与**形状**有关——所以造几条最难缠的（冒号、引号、颜文字、尖括号、
 * 空短评、上游被删）就够了。
 */

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../src/generate.js';

const rev = (fields) => ({
  parser_version: 'p/1',
  first_observed_at: '2026-08-01T00:00:00+08:00',
  last_observed_at: '2026-08-01T00:00:00+08:00',
  fields: {
    status: 'done',
    marked_at: { raw: '2026-08-01', iso: '2026-08-01T00:00:00+08:00', precision: 'day' },
    rating: null, comment: null, tags: null, ...fields,
  },
  digests: {},
  observations: [{ bundle_id: 'b', capture_ids: ['b#1'], observed_at: '2026-08-01T00:00:00+08:00', absence_authority: 'none' }],
});

// 最难缠的那几种，全是实测踩过的形状。
const HARD = [
  'a: b "c" #d [e] {f} & *g | > %h',            // YAML 的特殊字符
  '_(:з」∠)_ 颜文字，下划线不许被当成强调',        // Markdown 的强调
  'From <May December>',                         // 尖括号：不转义会整段消失
  '',                                            // 空短评 ≠ 没有短评
  '007',                                         // 看起来像数字
  'no',                                          // 看起来像布尔
];

const marks = HARD.map((comment, i) => ({
  canonical_version: 'canonical/1.0', identity_layer: 'upstream_id', upstream_id: String(i),
  account: { user_id: '1', username: 'x' }, medium: 'movie',
  subject: { id: String(1000 + i), url: null, upstream_deleted: i === 3 },
  revisions: [rev({ comment })],
}));
const subjects = marks.map((m, i) => ({
  canonical_version: 'canonical/1.0', medium: 'movie', id: m.subject.id,
  upstream_deleted: i === 3,
  revisions: [{
    parser_version: 'p/1', first_observed_at: 'x', last_observed_at: 'x',
    fields: {
      title: i === 3 ? null : `片名 ${i} / Title: ${i}`,
      cover_url: null, raw_meta: '2024 / 导演 / 美国',
      aliases: i === 0 ? ['又名(港/台)', 'Alias'] : [],
      info: i === 0 ? { 导演: ['某人'], '制片国家/地区': ['美国', '中国'] } : null,
    },
    digests: {}, observations: [],
  }],
}));
const broadcasts = [{
  canonical_version: 'canonical/1.0', identity_layer: 'upstream_id', upstream_id: '9',
  account: { user_id: '1' }, url: null,
  revisions: [{
    parser_version: 'p/1', first_observed_at: 'x', last_observed_at: 'x',
    fields: {
      posted_at: { raw: '2021-11-28 20:25:21', iso: '2021-11-28T20:25:21+08:00', precision: 'second' },
      text: '广播里也有 <尖括号> 和 _下划线_', action: '想看', status: 'wish',
      target_type: 'movie', target_id: '1000', images: [], text_truncated: false, full_text_url: null,
    },
    digests: {}, observations: [],
  }],
}];

const out = mkdtempSync(join(tmpdir(), 'doubak-smoke-'));
const r = generate({ canonical: { marks, subjects, longform: [], broadcasts }, outDir: out });

/**
 * 检查一份 front matter。
 *
 * ## 只验「引号串能不能读回来」是不够的
 *
 * 第一版就是那样，结果**把引号整个关掉它照样过**——因为它只检查带引号的值，
 * 而漏掉引号的值根本不会被看一眼。一个漏得掉自己要防的那件事的检查，
 * 比没有检查更糟：它给的是假的安心。
 *
 * ## 所以反过来写：**裸值必须是 YAML 里安全的裸值**
 *
 * 下面这些规则说的是 YAML 本身，不是我们的写入器。一个真正的 YAML 解析器
 * 遇到它们会解错或直接报错，而静态站生成器只会指着某个几千行文件里的某一行
 * 说「语法错误」——用户根本无从判断是自己的短评还是工具的锅。
 */
function checkFrontMatter(text, where) {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new Error(`${where}: 没有 front matter`);

  let i = 1;
  let closed = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '---') { closed = true; break; }

    const m = /^([A-Za-z0-9_]+): ?(.*)$/.exec(line);
    if (!m) throw new Error(`${where}: 读不懂这一行 → ${JSON.stringify(line.slice(0, 60))}`);
    const [, key, rest] = m;

    if (rest === '|-') {          // 块标量
      i += 1;
      while (i < lines.length && (lines[i] === '' || lines[i].startsWith('  '))) i += 1;
      continue;
    }
    if (rest === '') {            // 列表
      i += 1;
      while (i < lines.length && lines[i].startsWith('  - ')) i += 1;
      continue;
    }
    if (rest.startsWith('"')) {   // 引号串：必须能原样解回来
      try { JSON.parse(rest.replace(/\\x([0-9a-f]{2})/g, (_, h) => `\\u00${h}`)); }
      catch { throw new Error(`${where}: ${key} 的引号串读不回来 → ${rest.slice(0, 60)}`); }
      i += 1;
      continue;
    }

    // ── 裸值。下面每一条都是 YAML 会理解错的形状。
    const v = rest;
    const bad = (why) => { throw new Error(`${where}: ${key} 是裸值但${why} → ${JSON.stringify(v.slice(0, 60))}`); };

    if (v === '[]' || v === 'null') { i += 1; continue; }
    if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') { i += 1; continue; }
    // `a: b` —— YAML 会当成嵌套映射
    if (/:\s/.test(v)) bad('里面有「冒号加空格」，YAML 会当成嵌套映射');
    // 行首特殊字符
    if (/^[#&*!|>%@`?{}[\],'"-]/.test(v)) bad('以 YAML 的特殊字符开头');
    // 看起来像别的类型
    if (/^(yes|no|on|off|y|n|~|Yes|No|On|Off|True|False|NULL|Null)$/.test(v)) bad('会被解析成布尔或空值');
    if (/^0\d/.test(v) || /^\d+e\d+$/i.test(v) || /^\.\d/.test(v) || /^\d[\d_]*$/.test(v)) bad('会被解析成数字');
    if (/\s$/.test(v)) bad('以空白结尾，会被吃掉');
    i += 1;
  }
  if (!closed) throw new Error(`${where}: front matter 没闭合`);
}

const files = [];
(function walk(d, p = '') {
  for (const n of readdirSync(join(d, p))) {
    const rel = p ? join(p, n) : n;
    if (statSync(join(d, rel)).isDirectory()) walk(d, rel);
    else if (rel.endsWith('.md')) files.push(rel);
  }
})(join(out, 'content'));

for (const f of files) checkFrontMatter(readFileSync(join(out, 'content', f), 'utf-8'), f);

// ── 链接协议。
//
// **生成器自己产出的链接必须是相对路径或 https，绝不能是明文 http。**
// 一条 http:// 链接在 https 的站点上会被浏览器当作混合内容拦掉或降级，
// 而它长得和正常链接一模一样——不点开根本看不出来。
//
// 用户自己写在短评里的 http:// 不算：那是**他当年写的字**，改掉就是档案在
// 篡改内容（实测样张里有一条 2015 年的百度网盘链接）。它以纯文本呈现，
// 不会发起任何请求。所以这里只查我们生成的 Markdown 链接与图片。
const badLinks = [];
for (const f of files) {
  const text = readFileSync(join(out, 'content', f), 'utf-8');
  // ![](url) 与 [文字](url) —— 生成器产出的那两种
  for (const m of text.matchAll(/!?\[[^\]]*\]\((http:\/\/[^)]*)\)/g)) badLinks.push([f, m[1]]);
  // front matter 里的 URL 字段
  for (const m of text.matchAll(/^douban_\w+: "?(http:\/\/[^"\n]*)"?$/gm)) badLinks.push([f, m[1]]);
}
if (badLinks.length) {
  for (const [f, u] of badLinks.slice(0, 5)) console.error(`  明文 http：${f} → ${u}`);
  throw new Error(`${badLinks.length} 处生成的链接用了明文 http`);
}

// 索引也要能被解出来——它是 .js，但内容必须是合法 JSON。
const idx = readFileSync(join(out, 'static/search-index.js'), 'utf-8');
const rows = JSON.parse(idx.slice(idx.indexOf('=') + 1, idx.lastIndexOf(';')));

console.log(`冒烟通过：${files.length} 个页面、${rows.length} 条索引，front matter 全部可读回。`);
