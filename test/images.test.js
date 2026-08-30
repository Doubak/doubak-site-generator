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

describe('一个目录里塞了好几份档案', () => {
  test('**有几份索引就读几份** —— 原来只读第一份，其余的图一张都取不到', () => {
    // 真实形状：`~/downloads/old` 是个下载文件夹，10 份档案的索引与段文件平铺
    // 在一起。只读第一份的话，另外 9 份的图全部取不到，而页面上只表现为
    // 「有几张封面缺了」——解析器那边刚修的是同一个 bug，两边必须一起修，
    // 否则 canonical 会引用一批本地根本没导出来的图。
    const root = makeBundle([{
      capture_id: 'a-1', url: 'https://img1.doubanio.com/x/first.jpg',
      surface: 'asset', route_key: 'asset.upload', body: 'first',
    }]);
    // 往同一个 bundle 目录里再塞一份档案的索引与段（文件名不同，互不覆盖）。
    const dir = join(root, 'bundle-a');
    const body = Buffer.from('second');
    const http = Buffer.concat([
      Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n\r\n'), body,
    ]);
    const warc = Buffer.concat([
      Buffer.from(`WARC/1.1\r\nWARC-Type: response\r\nContent-Length: ${http.length}\r\n\r\n`),
      http,
    ]);
    const gz = gzipSync(warc);
    writeFileSync(join(dir, 'seg-1.warc.gz'), gz);
    writeFileSync(join(dir, 'index-1.ndjson'), JSON.stringify({
      capture_id: 'b-1', url: 'https://img1.doubanio.com/x/second.jpg',
      verdict: 'ok', surface: 'asset', route_key: 'asset.upload',
      parent_capture_id: null, content_type: 'image/jpeg',
      segment: 'seg-1.warc.gz', offset: 0, length: gz.length,
    }) + '\n');

    const index = indexImages(root);
    assert.ok(index.byUrl.get('https://img1.doubanio.com/x/first.jpg'), '第一份要在');
    assert.ok(
      index.byUrl.get('https://img1.doubanio.com/x/second.jpg'),
      '**第二份也要在** —— 原来这一份是静悄悄丢掉的',
    );

    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index,
      wanted: ['https://img1.doubanio.com/x/first.jpg', 'https://img1.doubanio.com/x/second.jpg'],
      outDir: out,
    });
    assert.equal(res.written, 2);
    assert.deepEqual(res.missing, []);
    assert.equal(readFileSync(join(out, 'uploads/second.jpg'), 'utf-8'), 'second');
  });
});

describe('档案里有、但取不出来的图', () => {
  /**
   * 把某一条捕获的 gzip member 弄坏。
   *
   * 翻的是 member 末尾的 CRC32/ISIZE 那几个字节——比翻中间可靠：deflate 流里
   * 随便翻一位有可能仍然解得开（只是解出别的东西），而校验和一动必然报
   * 「incorrect data check」。**要模拟的是位腐坏，就得让它稳定地表现成位腐坏。**
   *
   * @param {string} root makeBundle 的返回值
   * @param {string} captureId 弄坏哪一条
   */
  function corrupt(root, captureId) {
    const dir = join(root, 'bundle-a');
    const rows = readFileSync(join(dir, 'index-0.ndjson'), 'utf-8')
      .trimEnd().split('\n').map((l) => JSON.parse(l));
    const row = rows.find((r) => r.capture_id === captureId);
    assert.ok(row, `夹具里没有 ${captureId}——测试自己写错了`);
    const seg = join(dir, 'seg-0.warc.gz');
    const bytes = readFileSync(seg);
    bytes[row.offset + row.length - 5] ^= 0xff;
    writeFileSync(seg, bytes);
    return row;
  }

  test('**一张图坏掉，其余的照样出得来**', () => {
    // 原来这里是不设防的：`gunzipSync` 一抛，异常穿过 exportImages 与 generate()
    // 一路冒到命令行，屏幕上只有 `Error: incorrect data check` 加一段 zlib 的
    // 栈回溯——没有图片地址、没有 capture_id、没有档案名，而且**一页站点都没生成**。
    const root = makeBundle([
      {
        capture_id: 'a-good', url: 'https://img1.doubanio.com/x/good.jpg',
        surface: 'asset', route_key: 'asset.upload', body: 'x'.repeat(400),
      },
      {
        capture_id: 'a-rot', url: 'https://img1.doubanio.com/x/rot.jpg',
        surface: 'asset', route_key: 'asset.upload', body: 'y'.repeat(400),
      },
    ]);
    corrupt(root, 'a-rot');

    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index: indexImages(root),
      wanted: ['https://img1.doubanio.com/x/good.jpg', 'https://img1.doubanio.com/x/rot.jpg'],
      outDir: out,
    });

    assert.equal(res.written, 1, '好的那张必须照常写出去');
    assert.equal(res.paths['https://img1.doubanio.com/x/good.jpg'], '/uploads/good.jpg');
    assert.equal(
      res.paths['https://img1.doubanio.com/x/rot.jpg'], undefined,
      '取不出来就不该留下路径——那会让页面上出现一张碎图',
    );
    assert.ok(
      !existsSync(join(out, 'uploads/rot.jpg')),
      '**盘上不许留 0 字节的 .jpg**：看起来有图、点开是坏的，比没有更糟',
    );
  });

  test('报的是 capture_id 与档案位置，不是一句 zlib 的错', () => {
    const root = makeBundle([{
      capture_id: 'a-rot', url: 'https://img1.doubanio.com/x/rot.jpg',
      surface: 'asset', route_key: 'asset.upload', body: 'y'.repeat(400),
    }]);
    corrupt(root, 'a-rot');

    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index: indexImages(root), wanted: ['https://img1.doubanio.com/x/rot.jpg'], outDir: out,
    });

    assert.equal(res.unreadable.length, 1);
    const [u] = res.unreadable;
    // 用户拿这条消息要做的事是**定位一份几百 MB 档案里的某一条捕获**，
    // 所以这三样缺一不可。
    assert.equal(u.captureId, 'a-rot');
    assert.equal(u.url, 'https://img1.doubanio.com/x/rot.jpg');
    assert.ok(u.dir.includes('bundle-a'), `要说清是哪份档案，实际是 ${u.dir}`);
    assert.match(u.error, /a-rot @ seg-0\.warc\.gz\+\d+/, '错误消息本身也要带上位置');
  });

  test('**「缺」与「读不出来」必须分开**', () => {
    // 下一步动作正好相反：缺的要重抓，读不出来的重抓没用。
    // 混成一句「缺 N 张」，用户就会去做那个不管用的动作。
    const root = makeBundle([{
      capture_id: 'a-rot', url: 'https://img1.doubanio.com/x/rot.jpg',
      surface: 'asset', route_key: 'asset.upload', body: 'y'.repeat(400),
    }]);
    corrupt(root, 'a-rot');

    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index: indexImages(root),
      wanted: ['https://img1.doubanio.com/x/rot.jpg', 'https://img1.doubanio.com/x/never.jpg'],
      outDir: out,
    });

    assert.deepEqual(
      res.missing, ['https://img1.doubanio.com/x/never.jpg'],
      '坏掉的那张不算「缺」——它就在档案里',
    );
    assert.equal(res.unreadable.length, 1);
    assert.equal(res.unreadable[0].captureId, 'a-rot');
  });

  test('坏掉的封面不写进 bySubject —— 走「没有封面就只剩文字」那条路', () => {
    const root = makeBundle(subjectWithCover(
      '35507345',
      'https://www.douban.com/location/drama/35507345/',
      'https://img1.doubanio.com/pview/drama_subject_poster/m/public/561e90f2.jpg',
    ).map((r) => (r.capture_id === 'a-35507345' ? { ...r, body: 'z'.repeat(400) } : r)));
    corrupt(root, 'a-35507345');

    const out = mkdtempSync(join(tmpdir(), 'doubak-out-'));
    const res = exportImages({
      index: indexImages(root), wanted: [], wantedBySubject: new Set(['35507345']), outDir: out,
    });

    assert.equal(
      res.bySubject['35507345'], undefined,
      '**不许留一个指向不存在文件的封面路径。** 页面上那是一张碎图，'
      + '而既定行为是「没有封面就只剩文字，不放占位图」',
    );
    assert.equal(res.unreadable.length, 1);
  });
});
