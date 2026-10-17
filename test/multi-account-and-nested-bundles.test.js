import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexImages } from '../src/images.js';
import { findCanonicalDirs, filterCanonicalByAccount, accountsInCanonical } from '../src/canonical.js';

test('images.js 深度递归扫描 bundle', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'img-recursive-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // 构造深度嵌套目录：root/sub1/sub2/bundleA
  const nestedBundle = join(tmp, 'sub1', 'sub2', 'bundleA');
  mkdirSync(nestedBundle, { recursive: true });
  writeFileSync(join(nestedBundle, 'manifest.json'), JSON.stringify({
    bundle_id: 'b_nested',
    account: { user_id: '888', nickname: 'NestedUser' },
  }));
  writeFileSync(join(nestedBundle, 'index-b_nested.ndjson'), JSON.stringify({
    capture_id: 'b_nested#000001',
    intent: 'interest.movie.collect',
    route_key: 'interest.movie.collect',
    url: 'https://img1.doubanio.com/view/subject/s/public/s123.jpg',
    surface: 'asset',
    verdict: 'ok',
    observed_at: '2026-08-01T00:00:00Z',
  }) + '\n');

  // indexImages 递归能找到 nestedBundle
  const res = indexImages(tmp);
  assert.equal(res.bundles.length, 1);
  assert.equal(res.bundles[0].account.user_id, '888');
  assert.ok(res.byUrl.has('https://img1.doubanio.com/view/subject/s/public/s123.jpg'));

  // 指定 account 过滤
  const res888 = indexImages(tmp, { account: '888' });
  assert.equal(res888.bundles.length, 1);

  const resOther = indexImages(tmp, { account: '999' });
  assert.equal(resOther.bundles.length, 0);
});

test('站点生成器多账号防护与子目录探测', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'site-multi-account-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const mixedDir = join(tmp, 'mixed');
  mkdirSync(mixedDir, { recursive: true });
  const marks = [
    { upstream_id: 'm1', medium: 'movie', subject: { id: 's1', title: 'Film 1' }, account: { user_id: '100', nickname: 'Alice' }, revisions: [{ fields: { status: 'done', marked_at: { iso: '2026-01-01' } } }] },
    { upstream_id: 'm2', medium: 'movie', subject: { id: 's2', title: 'Film 2' }, account: { user_id: '200', nickname: 'Bob' }, revisions: [{ fields: { status: 'done', marked_at: { iso: '2026-01-01' } } }] },
  ];
  writeFileSync(join(mixedDir, 'marks.ndjson'), marks.map(m => JSON.stringify(m)).join('\n') + '\n');
  writeFileSync(join(mixedDir, 'profile.ndjson'), '');

  // 1. 混合账号直接生成应当阻断（exit code 1）
  const r1 = spawnSync(process.execPath, ['bin/generate.js', mixedDir, tmp, join(tmp, 'out1'), '--no-theme'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /输入中有多个账号/);

  // 2. --account 100 过滤生成成功（exit code 0）
  const out2 = join(tmp, 'out2');
  const r2 = spawnSync(process.execPath, ['bin/generate.js', mixedDir, tmp, out2, '--account', '100', '--no-theme'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r2.status, 0);
  assert.ok(existsSync(join(out2, 'content/_index.md')));
  const indexMd = readFileSync(join(out2, 'content/_index.md'), 'utf-8');
  assert.match(indexMd, /Alice的豆瓣存档/);

  // 3. --all-accounts 批量分流生成（exit code 0）
  const out3 = join(tmp, 'out3');
  const r3 = spawnSync(process.execPath, ['bin/generate.js', mixedDir, tmp, out3, '--all-accounts', '--no-theme'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r3.status, 0);
  assert.ok(existsSync(join(out3, '100', 'content/_index.md')));
  assert.ok(existsSync(join(out3, '200', 'content/_index.md')));
  assert.match(readFileSync(join(out3, '100', 'content/_index.md'), 'utf-8'), /Alice的豆瓣存档/);
  assert.match(readFileSync(join(out3, '200', 'content/_index.md'), 'utf-8'), /Bob的豆瓣存档/);

  // 4. 子目录自动定位探测
  const parentDir = join(tmp, 'parent');
  const sub1 = join(parentDir, 'sub_alice');
  mkdirSync(sub1, { recursive: true });
  writeFileSync(join(sub1, 'marks.ndjson'), JSON.stringify(marks[0]) + '\n');
  const out4 = join(tmp, 'out4');
  const r4 = spawnSync(process.execPath, ['bin/generate.js', parentDir, tmp, out4, '--no-theme'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r4.status, 0);
  assert.match(r4.stdout, /自动定位到子目录中的 canonical 存档/);
});
