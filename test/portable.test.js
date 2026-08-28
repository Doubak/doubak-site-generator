/**
 * 「排页面」这一段要能原样跑在浏览器扩展里，所以**不许碰内建模块**。
 *
 * ## 边界在哪儿
 *
 * `generate.js` 干三件事：把图片字节从 WARC 里搬出来（I/O）、把投影排成一棵页面树
 * （纯计算）、把文本写到盘上（I/O）。中间那件事扩展也要做——它的导出页要在本地出
 * **同一棵树**——所以拆进了 `pages.js`。
 *
 * 图片路径是传进来的（`images` / `coverBySubject` 两张表），于是这一层不需要知道
 * 图片是从文件系统来的还是从 OPFS 来的。
 *
 * ## 为什么这条测试值得写
 *
 * 往 `pages.js` 里加一行 `import { join } from 'node:path'` 在这个仓库里毫无问题
 * ——`npm test` 全绿，`npm run md` 照跑。炸的地方在扩展，而且离这儿很远。
 *
 * 而且**破坏它的诱惑是具体的**：拼路径时 `join()` 比模板串顺手。所以那一处特意用
 * 了 `content/${rel}`——zip 内与站点里的分隔符本来就只有 `/` 一种。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * 扩展要拿走的入口。**改这张表就是在改跨仓库的契约**——扩展那边
 * `tools/sync-vendor.mjs` 有一份对应的名单。
 */
const PORTABLE_ENTRIES = ['pages.js', 'image-index.js'];

test('pages.js / image-index.js 及其传递依赖都不 import node: 内建模块', async () => {
  const seen = new Set();
  const queue = PORTABLE_ENTRIES.map((e) => resolve(SRC, e));
  const bad = [];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, 'utf-8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) queue.push(resolve(dirname(file), m[1]));
    for (const m of text.matchAll(/from\s+'(node:[^']+)'/g)) {
      bad.push(`${file.slice(SRC.length + 1)} → ${m[1]}`);
    }
  }

  // **断言真的扫到了东西。** 正则一旦写坏，这条测试会变成空循环而永远绿——
  // 那比没有测试更糟，它给的是假的安心。pages 会拉进 projection / markdown /
  // yaml / search，所以闭包至少有 5 个文件。
  assert.ok(seen.size >= 5, `闭包只有 ${seen.size} 个文件，import 的正则大概坏了`);
  assert.deepEqual(bad, [], `这几个文件扩展要原样拿走，不能碰内建模块：\n${bad.join('\n')}`);
});

test('generate.js 仍然是那个做 I/O 的，没把逻辑收回去', async () => {
  // 反向的一条：`pages.js` 干净不代表分工还在。如果哪天有人把排页面的代码
  // 又抄回 `generate.js`，两边就各有一份，而分叉的样子是「命令行出的树和
  // 扩展出的树不一样」——少一页、多一页、次序不同，打开都很正常。
  const gen = await readFile(join(SRC, 'generate.js'), 'utf-8');
  assert.match(gen, /from '\.\/pages\.js'/, 'generate.js 必须用 pages.js 排页面');
  assert.ok(!/function homePage/.test(gen), '首页又被抄回 generate.js 了');
  assert.ok(!/const SECTION_ORDER/.test(gen), '小节顺序又被抄回 generate.js 了');
});

test('images.js 只剩读字节，判定在 image-index.js 里', async () => {
  // 「哪张图是哪张」曾经和「怎么把它读出来」搅在一起。扩展要的是前者：
  // 只按 URL 找封面会漏掉 95 张明明就在档案里的图，而那条判定必须两边一致。
  const img = await readFile(join(SRC, 'images.js'), 'utf-8');
  assert.match(img, /from '\.\/image-index\.js'/);
  assert.ok(!/const m = \/\(\?:\\\/subject/.test(img), 'subjectIdOf 又被抄回 images.js 了');
});
