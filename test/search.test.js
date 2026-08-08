/**
 * 搜索索引。
 *
 * 这一层的错误都是**静默**的：索引里少了一类东西、或者链接的形状与站点对不上，
 * 页面照样渲染、搜索框照样能打字，只是搜不到 / 点了没反应。所以测试盯的是
 * 「该在的在不在」和「链接约定对不对」，不是「代码跑不跑得动」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSearchIndex } from '../src/search.js';

const THEME = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'hugo');

/** 造一份投影。 */
const proj = (over = {}) => ({
  marks: [], longform: [], broadcasts: [], ...over,
});
const pmark = (o = {}) => ({
  medium: 'movie', subjectId: '1292052', title: '霸王别姬', comment: '很好',
  markedAtRaw: '2026-08-01', status: 'done', aliases: [], ...o,
});
const pbc = (o = {}) => ({
  id: '1', text: '说了点什么', postedAtRaw: '2021-11-28 20:25:21', images: [], ...o,
});

describe('索引里该有什么', () => {
  test('标记、广播、长文都收', () => {
    const { rows } = buildSearchIndex(proj({
      marks: [pmark()], broadcasts: [pbc()],
      longform: [{ kind: 'note', id: '9', title: '日记', body: '正文', publishedAtRaw: '2025-01-01' }],
    }));
    assert.deepEqual(rows.map((r) => r.t).sort(), ['b', 'l', 'm']);
  });

  test('**上游被删、没有标题的作品也要收**', () => {
    // 标题是 null，但用户自己写的短评还在——那恰恰是最该搜得到的东西。
    const { rows } = buildSearchIndex(proj({ marks: [pmark({ title: null, comment: '当年觉得很好' })] }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].n, null);
    assert.equal(rows[0].c, '当年觉得很好');
  });

  test('**没有正文的广播不收** —— 否则结果里全是「想看 X」', () => {
    // 纯标记动作在标记那一条里已经搜得到了，收进来只会把结果稀释掉。
    const { rows } = buildSearchIndex(proj({ broadcasts: [pbc({ text: null }), pbc({ text: '有正文' })] }));
    assert.equal(rows.filter((r) => r.t === 'b').length, 1);
  });

  test('**路径不带扩展名** —— 那是 SSG 的决定，不是索引的', () => {
    // 带上 .html 就把一种固定链接方案焊进了数据里，而这份索引是给任何 SSG 用的。
    const { rows } = buildSearchIndex(proj({ marks: [pmark()], broadcasts: [pbc()] }));
    for (const r of rows) assert.ok(!/\.(html|md)$/.test(r.u), `${r.u} 不该带扩展名`);
    assert.equal(rows.find((r) => r.t === 'm').u, 'movie/1292052');
    assert.equal(rows.find((r) => r.t === 'b').u, 'broadcast/2021-11');
  });

  test('**又名进索引** —— 它是搜索时最有用、别处又拿不到的一项', () => {
    // 实测那 2011 个有又名的作品里装着的是台译名、港译名、原文名：
    //   重返寂静岭 → 重返沉默之丘(台) / 重返鬼魅山房 / 寂静岭2真人版
    // 记得住《重返沉默之丘》却想不起《寂静岭2》的人，没有它就什么都搜不到。
    const { rows } = buildSearchIndex(proj({
      marks: [pmark({ title: '重返寂静岭', aliases: ['重返沉默之丘(台)', '寂静岭2真人版'] })],
    }));
    assert.deepEqual(rows[0].a, ['重返沉默之丘(台)', '寂静岭2真人版']);
  });

  test('没有又名时**不要那个键**，而不是设成 undefined', () => {
    // JSON.stringify 会把 undefined 的键整个丢掉，于是对象与产出对不上。
    const { rows, js } = buildSearchIndex(proj({ marks: [pmark({ aliases: [] })] }));
    assert.ok(!('a' in rows[0]));
    assert.deepEqual(JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(';'))), rows);
  });

  test('按时间倒序', () => {
    const { rows } = buildSearchIndex(proj({
      marks: [pmark({ markedAtRaw: '2020-01-01' }), pmark({ subjectId: '2', markedAtRaw: '2026-01-01' })],
    }));
    assert.deepEqual(rows.map((r) => r.d), ['2026-01-01', '2020-01-01']);
  });
});

describe('产出的是 .js', () => {
  test('**挂成全局变量，而不是等着被 fetch**', () => {
    // 浏览器在 file:// 下会拦掉 fetch 与 XHR，但 <script> 照常工作。
    // 用 fetch 的话，站点在 http 下能搜、双击打开就废。
    const { js } = buildSearchIndex(proj({ marks: [pmark()] }));
    assert.match(js, /window\.DOUBAK_SEARCH=\[/);
    assert.match(js, /;\n$/);
  });

  test('内容是合法 JSON', () => {
    const { js, rows } = buildSearchIndex(proj({ marks: [pmark({ comment: '带"引号"和\\反斜杠' })] }));
    const parsed = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(';')));
    assert.deepEqual(parsed, rows);
  });
});

describe('搜索页', () => {
  const html = existsSync(join(THEME, 'layouts/_default/search.html'))
    ? readFileSync(join(THEME, 'layouts/_default/search.html'), 'utf-8') : '';

  test('**用 script 标签载索引，不用 fetch**', () => {
    assert.ok(html, '搜索页模板不见了');
    assert.match(html, /createElement\('script'\)/);
    assert.ok(!/fetch\(|XMLHttpRequest/.test(html), 'file:// 下这两个都会被拦');
  });

  test('**索引路径是裸相对路径**', () => {
    // `/search-index.js` 在 file:// 下会去找文件系统根目录；`../` 会跑到站点外面。
    assert.match(html, /s\.src = 'search-index\.js'/);
  });

  test('**载入中、就绪、失败三种状态都有**', () => {
    // 只做「载入中」的话，失败时会永远转圈；只做「就绪」的话，慢网络下
    // 用户会以为搜索框坏了。
    assert.match(html, /idx-loading/);
    assert.match(html, /idx-ready/);
    assert.match(html, /idx-error/);
    assert.match(html, /onerror/);
  });

  test('**先转义再插高亮标记** —— 顺序反了就是个 XSS', () => {
    // 用户写的字里有尖括号很正常（实测「From <May December>」）。
    const snip = html.slice(html.indexOf('function snippet'), html.indexOf('function run'));
    assert.match(snip, /esc\(s\.slice\(0, j\)\) \+ '<mark>' \+ esc\(/);
  });

  test('**又名与标题同一档** —— 搜台译名和搜大陆译名该是一样的', () => {
    assert.match(html, /r\.a \? r\.a\.join/);
    assert.match(html, /inTitle = \(r\.n/);
  });

  test('零结果就说零结果', () => {
    assert.match(html, /没有找到/);
  });
});
