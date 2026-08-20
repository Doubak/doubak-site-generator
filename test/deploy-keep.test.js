/**
 * `deploy.js` 铺站点之前会清掉「上一次留下的残留」，而 `KEEP` 是那把刀的护栏。
 *
 * 这一层的错误代价高，而且**不可逆**：`rmSync` 之后仓库里就没有了。名单少一个名字，
 * 表现不是报错，是某个文件在一次例行的「重新生成站点」里静静消失，
 * 而下一次有人注意到，可能是几周之后。
 *
 * 测试是**读源码**而不是跑一遍：`bin/deploy.js` 是个有顶层副作用的脚本，
 * 真跑一次要先有 canonical、有 bundle、还要构建整站。而要守的东西是一个常量。
 * 静态检查的代价是它可能读到一个空名单还说通过，所以下面显式确认名单非空。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'bin', 'deploy.js'), 'utf8');

/** 从源码里把 KEEP 的字面量抠出来。 */
function keepList() {
  const m = /const KEEP = new Set\(\[([\s\S]*?)\]\)/.exec(SOURCE);
  assert.ok(m, '在 bin/deploy.js 里找不到 KEEP —— 是不是改名或改写法了？');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('名单读得出来，而且不是空的', () => {
  // 正则读到空名单会让下面每一条都「通过」，那是这类测试最典型的失效方式。
  const keep = keepList();
  assert.ok(keep.length >= 6, `只读到 ${keep.length} 项，像是没读全`);
});

test('仓库自己的东西一个都不能少', () => {
  const keep = new Set(keepList());
  for (const name of ['.git', '.gitignore', 'CNAME', 'LICENSE', 'README.md', '.github']) {
    assert.ok(keep.has(name), `KEEP 里少了 ${name}`);
  }
});

test('sitemap.xml 必须在名单里', () => {
  // 它由样张仓库那边的 CI 生成，不是这个生成器的产物。
  // 2026-08-20 真删过一次：当时的理由是「删了那边会重新生成」，
  // 而那条链路要等人合并一个 PR——在那之前线上站点没有 sitemap。
  //
  // 一般规则：**清残留只能清自己上一次铺下去的东西。** 别的流程放进仓库的产物，
  // 这里既不知道它怎么来的，也不知道它多久能回来，就不该替它做主。
  assert.ok(keepList().includes('sitemap.xml'), 'KEEP 里少了 sitemap.xml');
});

test('清理只发生在 KEEP 之外，而且判据就是这个名单', () => {
  // 防的是「名单还在，但已经没人用它了」——那样上面几条会全部通过而护栏已经没了。
  assert.match(SOURCE, /readdirSync\(repoDir\)\.filter\(\(n\) => !KEEP\.has\(n\)\)/);
});
