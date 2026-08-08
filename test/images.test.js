/**
 * 从 WARC 里把图片取出来。
 *
 * ## 为什么这一层值得单独造夹具
 *
 * 它是整个生成器里唯一读二进制的一步，而它出错的样子**不像出错**：页面照样生成、
 * 固定链接照样在、front matter 照样合法，只是图不见了——或者更糟，写出一个 0 字节的
 * .jpg，看起来「有图」而打不开。
 *
 * 实测踩过的那个坑尤其不显眼：canonical 里的 `cover_url` 取自**列表页缩略图**，
 * 档案里存的却是**详情页封面**。多数媒介两者恰好是同一个文件，所以按 URL 找能中
 * 96%——剩下 4%（实测 95 张）静悄悄地缺，而且缺的是舞台剧这种本来就少的媒介，
 * 肉眼几乎不可能发现。
 *
 * 所以这里造一份最小的真 bundle（真 gzip、真 WARC 记录、真 index），
 * 而不是把 `indexImages` 拆开来打桩——要守的性质恰恰是「这几段拼起来是对的」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexImages, exportImages, fileNameFor, releaseSegments } from '../src/images.js';

/**
 * 造一份最小 bundle：一个段文件 + 一份 index。
 *
 * @param {Array<{capture_id: string, url: string, body: string|Buffer} & object>} rows
 */
function makeBundle(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'doubak-img-'));
  mkdirSync(dir, { recursive: true });

  const chunks = [];
  const index = [];
  let offset = 0;

  for (const r of rows) {
    const body = Buffer.from(r.body ?? '');
    const http = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: ${r.content_type ?? 'image/jpeg'}\r\n\r\n`),
      body,
    ]);
    const warc = Buffer.concat([
      Buffer.from(`WARC/1.1\r\nWARC-Type: response\r\nContent-Length: ${http.length}\r\n\r\n`),
      http,
    ]);
    const gz = gzipSync(warc);
    chunks.push(gz);
    index.push(JSON.stringify({
      capture_id: r.capture_id,
      url: r.url,
      verdict: r.verdict ?? 'ok',
      surface: r.surface ?? 'asset',
      intent: r.intent,
      route_key: r.route_key,
      parent_capture_id: r.parent_capture_id ?? null,
      content_type: r.content_type ?? 'image/jpeg',
      segment: 'seg-0.warc.gz',
      offset,
      length: gz.length,
    }));
    offset += gz.length;
  }

  writeFileSync(join(dir, 'seg-0.warc.gz'), Buffer.concat(chunks));
  writeFileSync(join(dir, 'index-0.ndjson'), index.join('\n') + '\n');

  const root = mkdtempSync(join(tmpdir(), 'doubak-root-'));
  // bundle 目录名无所谓，`indexImages` 是遍历子目录找 index-*.ndjson 的。
  const inner = join(root, 'bundle-a');
  mkdirSync(inner);
  for (const f of ['seg-0.warc.gz', 'index-0.ndjson']) {
    writeFileSync(join(inner, f), readFileSync(join(dir, f)));
  }
  return root;
}

/** 一个作品详情页 + 挂在它下面的封面。 */
const subjectWithCover = (id, pageUrl, coverUrl) => ([
  {
    capture_id: `c-${id}`, url: pageUrl, surface: 'page',
    intent: 'interest.item', route_key: 'interest.item', body: '<html></html>',
    content_type: 'text/html',
  },
  {
    capture_id: `a-${id}`, url: coverUrl, surface: 'asset',
    route_key: 'asset.subject_cover', parent_capture_id: `c-${id}`,
    body: `bytes-of-${id}`,
  },
]);

describe('按作品 id 找封面', () => {
  test('**列表页缩略图与详情页封面不同名时，仍然找得到**', () => {
    // 实测舞台剧：
    //   列表页  …/pview/drama_subject_poster/small/public/561e90f2.jpg
    //   详情页  …/pview/drama_subject_poster/m/public/561e90f2.jpg
    // 只按 URL 找的话这一张落空，而它明明就在档案里。
    const root = makeBundle(subjectWithCover(
      '35507345',
      'https://www.douban.com/location/drama/35507345/',
      'https://img1.doubanio.com/pview/drama_subject_poster/m/public/561e90f2.jpg',
    ));
    const index = indexImages(root);
    const listThumb = 'https://img1.doubanio.com/pview/drama_subject_poster/small/public/561e90f2.jpg';

    assert.equal(index.byUrl.get(listThumb), undefined, '按 URL 本来就该找不到');

    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index, wanted: [listThumb], wantedBySubject: new Set(['35507345']), outDir: out,
    });
    assert.equal(res.bySubject['35507345'], '/covers/561e90f2.jpg');
    assert.equal(
      readFileSync(join(out, 'covers/561e90f2.jpg'), 'utf-8'), 'bytes-of-35507345',
      '写出去的必须是详情页那张的字节，不是一个空文件',
    );
  });

  test('五种媒介的详情页 URL 都要认得出来', () => {
    // 认不出来的那一种会整类缺封面——而那看起来像「豆瓣就是没图」，不像 bug。
    const cases = {
      36838707: 'https://movie.douban.com/subject/36838707/',
      1084336: 'https://book.douban.com/subject/1084336/',
      2995812: 'https://music.douban.com/subject/2995812/',
      25945305: 'https://www.douban.com/game/25945305/',
      35507345: 'https://www.douban.com/location/drama/35507345/',
    };
    const rows = Object.entries(cases).flatMap(([id, url]) => subjectWithCover(
      id, url, `https://img1.doubanio.com/x/${id}.jpg`,
    ));
    const index = indexImages(makeBundle(rows));
    for (const id of Object.keys(cases)) {
      assert.ok(index.bySubject.has(id), `${cases[id]} 没能反解出作品 id`);
    }
  });

  test('封面没有 parent 时不乱认 —— 宁可缺一张，不能张冠李戴', () => {
    // 把别人的封面贴到你的标记上，比缺图糟得多：页面看起来完全正常。
    const root = makeBundle([{
      capture_id: 'a-1', url: 'https://img1.doubanio.com/x/1.jpg',
      surface: 'asset', route_key: 'asset.subject_cover', parent_capture_id: null,
      body: 'x',
    }]);
    assert.equal(indexImages(root).bySubject.size, 0);
  });
});

describe('只认抓到手的字节', () => {
  test('**verdict 不是 ok 的一律不导出**', () => {
    // 被拦下的那些载荷是封锁页或十几字节的占位符。写成 .jpg 会得到一个打不开的
    // 文件——而那比没有文件更糟：页面上看起来「有图」。
    const root = makeBundle([{
      capture_id: 'a-1', url: 'https://img1.doubanio.com/x/1.jpg',
      surface: 'asset', route_key: 'asset.upload', verdict: 'blocked',
      body: '<html>请稍后再试</html>',
    }]);
    const index = indexImages(root);
    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index, wanted: ['https://img1.doubanio.com/x/1.jpg'], outDir: out,
    });
    assert.deepEqual(res.missing, ['https://img1.doubanio.com/x/1.jpg']);
    assert.equal(res.written, 0);
    assert.ok(!existsSync(join(out, 'uploads/1.jpg')));
  });

  test('用户上传的图与作品封面分开放', () => {
    // 两者的保留策略、删除语义、法律处境都不同（CLAUDE.md）。放同一个目录里，
    // 「只发布自己的东西」这件事就没法用一句 rm 做到。
    const root = makeBundle([
      {
        capture_id: 'a-1', url: 'https://img1.doubanio.com/x/p1.jpg',
        surface: 'asset', route_key: 'asset.upload', body: 'mine',
      },
      {
        capture_id: 'a-2', url: 'https://img1.doubanio.com/x/c1.jpg',
        surface: 'asset', route_key: 'asset.subject_cover', body: 'theirs',
      },
    ]);
    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index: indexImages(root),
      wanted: ['https://img1.doubanio.com/x/p1.jpg', 'https://img1.doubanio.com/x/c1.jpg'],
      outDir: out,
    });
    assert.equal(res.paths['https://img1.doubanio.com/x/p1.jpg'], '/uploads/p1.jpg');
    assert.equal(res.paths['https://img1.doubanio.com/x/c1.jpg'], '/covers/c1.jpg');
  });

  test('文件名沿用豆瓣的 —— 重新生成之后链接不变', () => {
    assert.equal(fileNameFor('https://img3.doubanio.com/view/x/p742323977.jpg'), 'p742323977.jpg');
    // 认不出扩展名就用 Content-Type 补，补不出来用 .bin，不猜。
    assert.equal(fileNameFor('https://img3.doubanio.com/view/x/abc', 'image/png'), 'abc.png');
    assert.equal(fileNameFor('https://img3.doubanio.com/view/x/abc', 'application/octet-stream'), 'abc.bin');
  });
});

test('跑完要放掉段缓存', () => {
  // 缓存的代价是峰值内存等于最大的那个段——实测那份真实档案是 159 MB。
  // 不放掉的话它会一直挂着。
  releaseSegments();
});
