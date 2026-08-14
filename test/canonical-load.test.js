/**
 * 三个入口读 canonical，名单只许有一份。
 *
 * 这条是被一次真实的漏改逼出来的：加豆列那一类的时候，`bin/generate.js` 改了，
 * `bin/site.js` 与 `bin/deploy.js` 没改。后果不是报错——缺的那一类被读成 `[]`，
 * 生成器照常跑完，只是**少了几十页而且一路绿灯**。表现是 `npm run md` 有豆列，
 * `npm run site` 与 `npm run deploy` 没有。
 *
 * 与 `SECTION_ORDER` 那次同一种形状：一份清单抄了三处，加东西时漏一处，没有任何
 * 东西会红。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANONICAL_FILES, readCanonical } from '../src/canonical.js';

const BINS = ['bin/generate.js', 'bin/site.js', 'bin/deploy.js'];

describe('canonical 的文件名单只有一份', () => {
  test('三个入口都走 readCanonical，没有谁自己再列一遍', () => {
    for (const f of BINS) {
      const src = readFileSync(f, 'utf-8');
      assert.match(src, /readCanonical\(/, `${f} 没走统一的读取`);
      assert.doesNotMatch(
        src, /['"]\w+\.ndjson['"]/,
        `${f} 里还自己写着 ndjson 文件名 —— 名单只该有一份（src/canonical.js）`,
      );
    }
  });

  test('五类记录都在名单里', () => {
    // 少一类不会报错，只会让站点静静地少几十页。
    assert.deepEqual(
      Object.keys(CANONICAL_FILES).sort(),
      ['broadcasts', 'doulists', 'longform', 'marks', 'subjects'],
    );
  });

  test('缺文件读成空数组，不抛', () => {
    // 老档案解析出来的 canonical 里没有新增的那几类，那不是错误——重跑解析器就有了。
    const dir = mkdtempSync(join(tmpdir(), 'canon-'));
    writeFileSync(join(dir, 'marks.ndjson'), '{"a":1}\n');
    const r = readCanonical(dir);
    assert.equal(r.marks.length, 1);
    assert.deepEqual(r.doulists, []);
    assert.deepEqual(r.broadcasts, []);
  });

  test('空文件与只有换行的文件也读成空数组', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canon-'));
    writeFileSync(join(dir, 'doulists.ndjson'), '');
    writeFileSync(join(dir, 'marks.ndjson'), '\n\n');
    const r = readCanonical(dir);
    assert.deepEqual(r.doulists, []);
    assert.deepEqual(r.marks, []);
  });
});
