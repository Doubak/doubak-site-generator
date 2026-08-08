/**
 * 取 Hugo 二进制这一步。
 *
 * 这里下载并**执行**一个二进制文件，所以这一层的错误代价比别处高。测试盯的不是
 * 「能不能下下来」（那要联网，而且下不下来一眼就知道），而是那几条不联网也该成立、
 * 一旦松掉就没人会发现的规矩。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HUGO_VERSION, HUGO_SHA256, platformKey, untarOne, ensureHugo } from '../src/hugo-bin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('版本与校验和', () => {
  test('**版本钉死，不是 latest**', () => {
    // 存档站要能在几年后逐字节重建。latest 意味着同一份档案在不同时间会生成出
    // 不同的站点——那就等于没有「重建」这回事。
    assert.match(HUGO_VERSION, /^\d+\.\d+\.\d+$/);
    for (const f of ['src/hugo-bin.js']) {
      assert.ok(!/releases\/latest/.test(readFileSync(join(ROOT, f), 'utf-8')), `${f} 里不该出现 latest`);
    }
  });

  test('**每个支持的平台都得有校验和**', () => {
    // 少一个的话那个平台会在校验那步抛错——响亮地坏掉，这是想要的。
    // 但更想要的是它压根不该少，所以这里守住。
    for (const arch of ['x64', 'arm64', 'arm']) {
      const key = platformKey('linux', arch);
      assert.ok(key, `linux/${arch} 认不出来`);
      assert.match(HUGO_SHA256[key] ?? '', /^[0-9a-f]{64}$/, `${key} 没有校验和`);
    }
  });

  test('认不出的平台返回 null，**不猜**', () => {
    // 猜一个的话会去下一个不存在的文件，报出来的是 404 而不是「这个平台没有包」。
    assert.equal(platformKey('darwin', 'arm64'), null);
    assert.equal(platformKey('win32', 'x64'), null);
    assert.equal(platformKey('linux', 'mips'), null);
  });

  test('平台不支持时的报错要说清楚怎么办', async () => {
    // 「不支持」是个死路，那就至少给出活路——否则用户只能去读源码。
    const orig = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      await assert.rejects(
        () => ensureHugo({ cacheDir: join(ROOT, '.hugo-nonexistent'), allowDownload: false }),
        /brew install hugo|没有可以直接下载/,
      );
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  });
});

describe('解包', () => {
  test('从 tar 里取出指定文件', () => {
    // 自己读 tar 是为了不调 `tar`——各平台 shell 的差异比 512 字节的头麻烦。
    const tar = makeTar([['readme.md', 'hi'], ['hugo', 'BINARY'], ['LICENSE', 'x']]);
    assert.equal(untarOne(tar, 'hugo').toString(), 'BINARY');
    assert.equal(untarOne(tar, 'readme.md').toString(), 'hi');
  });

  test('没有那个文件就返回 null，不返回别的文件', () => {
    // 返回错文件的话，我们会把一个 README 写成可执行文件然后去跑它。
    assert.equal(untarOne(makeTar([['readme.md', 'hi']]), 'hugo'), null);
  });

  test('内容按 512 对齐，跨块也要取对', () => {
    const big = 'A'.repeat(1500);
    const tar = makeTar([['pad', 'x'], ['hugo', big]]);
    assert.equal(untarOne(tar, 'hugo').toString(), big);
  });
});

describe('已经下下来的那个', () => {
  const cached = join(ROOT, '.hugo', `hugo-${HUGO_VERSION}`);

  test('**缓存里的 hugo 版本必须与钉死的一致**', (t) => {
    if (!existsSync(cached)) return t.skip('还没下过');
    // 版本对不上说明缓存是上一次钉的那个版本留下的——而文件名里带版本号
    // 正是为了防这件事，所以这条测试同时也在守那个命名。
    const out = execFileSync(cached, ['version'], { encoding: 'utf-8' });
    assert.ok(out.includes(`v${HUGO_VERSION}`), `缓存里是 ${out.trim()}，钉的是 ${HUGO_VERSION}`);
  });
});

/** 造一个最小的 tar。只写普通文件，够测就行。 */
function makeTar(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const head = Buffer.alloc(512);
    head.write(name, 0, 'utf-8');
    head.write('0000644\0', 100);
    head.write(Buffer.byteLength(content).toString(8).padStart(11, '0') + '\0', 124);
    head.write('0', 156);
    head.write('ustar\0', 257);
    // 校验和字段：先填空格算和，再写回去。untarOne 不校验它，但写对了才像真的。
    head.write(' '.repeat(8), 148);
    let sum = 0;
    for (const b of head) sum += b;
    head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(head);
    const body = Buffer.from(content);
    blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
