/**
 * 把图片字节从 WARC 里取出来，写成文件。
 *
 * ## 为什么非做不可
 *
 * 不导出的话，生成的站点里每一张图都是一个指向 `doubanio.com` 的 URL——**这份备份
 * 要联网才能看，而且要豆瓣还在才能看**。那正是这个项目存在的理由所要否定的东西
 * （DESIGN F-04e）。前代工具的备份就卡在这一点上。
 *
 * ## canonical 里只有 URL，字节在 bundle 里
 *
 * 这是刻意的：canonical 是文本，用 `jq` 就能查，不装二进制。所以这一步要同时读
 * canonical（知道要哪些图）与 bundle（拿字节）。
 *
 * 依然**零网络请求**——「丢掉所有派生数据、只靠 captures 重建」那条不变量在这里
 * 同样成立，站点也是派生数据。
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import {
  buildImageIndex, fileNameFor, subdirFor, reallyMissing,
} from './image-index.js';

export { fileNameFor, reallyMissing };

const SEP = '\r\n\r\n';

/**
 * 扫一遍所有 bundle，建一张「图片 URL → 在哪条记录里」的表。
 *
 * 只认 `verdict: ok` 的：被拦下的那些载荷是封锁页或 13 字节的占位符，写成 .jpg
 * 会得到一个打不开的文件——**而那比没有文件更糟**，因为页面上看起来有图。
 *
 * @param {string} root 装着一堆 bundle 的目录
 */
export function indexImages(root) {
  const bundles = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let idxNames;
    try {
      idxNames = readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.ndjson'));
    } catch { continue; }
    // **一个目录里有几份索引，就读几份。**
    //
    // 原来这里是 `.find(...)`，只取第一份。真实存在的形状：`~/downloads/old`
    // 是个下载文件夹，10 份档案的索引与段文件平铺在一起——那样只会读到 1 份，
    // 另外 9 份的图**一张都取不到**，而页面上只会表现为「有几张封面缺了」。
    //
    // 解析器那边刚修的是同一个 bug（`bundle-source.js` 的 `openAll`）。两边
    // 必须一起修：解析器读全了、这边没读全，canonical 会引用一批本地根本没
    // 导出来的图，而那正是「离线可看」失守的样子。
    for (const idxName of idxNames) {
      const rows = [];
      for (const line of readFileSync(join(dir, idxName), 'utf-8').split('\n')) {
        if (line.trim()) rows.push(JSON.parse(line));
      }
      bundles.push({ host: dir, rows });
    }
  }
  // 判定在 image-index.js 里——那是个纯函数，扩展也在用同一份。
  // 这里只做它做不了的事：把 index 从盘上读出来。
  const { byUrl, bySubject } = buildImageIndex(bundles);
  // 结果里的 `host` 就是目录名，下游按 `hit.dir` 用，所以在这儿改回来。
  const rename = (m) => new Map([...m].map(([k, v]) => [k, { dir: v.host, row: v.row }]));
  return { byUrl: rename(byUrl), bySubject: rename(bySubject) };
}


/**
 * 段文件缓存。
 *
 * **不缓存的话这一步慢到不可用。** 每张图都重读一遍整个段——实测那份真实档案的
 * `catalog-*.warc.gz` 是 159 MB，读一次 114 ms，而 2918 张封面就是 5 分半，
 * 全花在重复读同一个文件上。
 *
 * 对比之下真正的工作快得多：300 张图解压 55 ms、写盘 11 ms。也就是说不缓存的话
 * **99% 的时间在做无用功**，而且它看起来只是「有点慢」，不像 bug。
 *
 * 段是只读的，缓存没有一致性问题；代价是峰值内存等于最大的那个段。
 * @type {Map<string, Buffer>}
 */
const SEGMENTS = new Map();

/** 放掉缓存。跑完一次就调一次，否则那 159 MB 会一直挂着。 */
export function releaseSegments() {
  SEGMENTS.clear();
}

/**
 * 把一条捕获的载荷取出来。
 *
 * @param {string} dir @param {object} row
 * @returns {Buffer}
 */
export function payload(dir, row) {
  const key = join(dir, row.segment);
  if (!SEGMENTS.has(key)) SEGMENTS.set(key, readFileSync(key));
  const seg = SEGMENTS.get(key);

  // **每一处都带上 capture_id 与段名再抛。** zlib 原样抛出来的是
  // 「incorrect data check」，而 `Content-Length` 那一行匹配不上时更糟——
  // 原来写的是 `.exec(...)[1]`，报的会是「Cannot read properties of null」，
  // 一句与档案毫无关系的话。调用方要拿这个消息去定位一份几百 MB 的档案里的
  // 某一条捕获，所以位置必须在消息里，不能只在栈回溯里。
  const where = `${row.capture_id ?? '?'} @ ${row.segment}+${row.offset}`;
  let raw;
  try {
    raw = gunzipSync(seg.subarray(row.offset, row.offset + row.length));
  } catch (err) {
    throw new Error(`${where}: 这一段解压不开（${err.message ?? err}）`);
  }
  const headEnd = raw.indexOf(SEP);
  const warcHead = raw.subarray(0, headEnd).toString('utf-8');
  const m = /^Content-Length: (\d+)$/m.exec(warcHead);
  if (!m) throw new Error(`${where}: WARC 头里没有 Content-Length`);
  const block = raw.subarray(headEnd + SEP.length, headEnd + SEP.length + Number(m[1]));
  const bodyAt = block.indexOf(SEP);
  return bodyAt < 0 ? block : block.subarray(bodyAt + SEP.length);
}

/**
 * 导出需要的图片。
 *
 * @param {object} opts
 * @param {Map<string, {dir: string, row: object}>} opts.index  `indexImages` 的产出
 * @param {Iterable<string>} opts.wanted  要导出的图片 URL
 * @param {string} opts.outDir  写到哪儿（通常是 `static/`）
 * @param {string} opts.urlPrefix  写进 Markdown 的路径前缀（通常是 `/`）
 * @returns {{paths: Record<string,string>, written: number, missing: string[],
 *   unreadable: Array<{url: string, captureId: string, dir: string, error: string}>}}
 *   `missing` 是**档案里没有的**图。它们不该被静默忽略：那意味着站点上会缺一张图，
 *   而缺的原因（那次抓取被拦下了 / 那条路线还没做）是用户该知道的。
 *
 *   `unreadable` 是**档案里有、但取不出来的**图：段文件那一段解压不开。两者必须
 *   分开报，因为**下一步动作正好相反**——缺的要重抓（去豆瓣再要一次），
 *   读不出来的重抓没有用（豆瓣那边好好的），要做的是把这份档案重新拷一遍
 *   或者重新导一次。混成一句「缺 N 张」，用户就会去做那个不管用的动作。
 */
export function exportImages({ index, wanted, wantedBySubject = new Map(), outDir, urlPrefix = '/' }) {
  /** @type {Record<string, string>} */
  const paths = {};
  /** @type {Record<string, string>} */
  const bySubject = {};
  /** @type {string[]} */
  const missing = [];
  /** @type {Array<{url: string, captureId: string, dir: string, error: string}>} */
  const unreadable = [];
  /** 同一条捕获可能被找两遍（先按作品 id，再按 URL），坏了也只报一次。 */
  const reported = new Set();
  let written = 0;

  /**
   * 写一张图。**取不出字节时返回 null，而不是把整趟生成炸掉。**
   *
   * 原来这里是不设防的：`payload()` 里那句 `gunzipSync` 一抛，异常直接穿过
   * `exportImages`、`generate()`，一路冒到命令行——真实档案上试过，屏幕上是
   *
   *     Error: incorrect data check
   *         at payload (src/images.js:92:15)
   *
   * 没有图片地址、没有 capture_id、没有档案名，站也一页都没生成。而这件事的
   * 起因（某个 assets 段里几个字节坏了）离这里隔着解析器与整条生成流程——
   * 解析器**根本不打开图片行**，所以它一声不吭地跑完了，坏消息全压到最后一步
   * 以一个 zlib 的栈回溯的形式出现。
   *
   * 一张图坏掉不该让另外几千张也生成不出来：**能出的先出，坏的点名说。**
   */
  const write = (hit) => {
    const sub = subdirFor(hit.row);
    const rel = `${sub}/${fileNameFor(hit.row.url, hit.row.content_type)}`;
    const abs = join(outDir, rel);
    if (!existsSync(abs)) {
      let bytes;
      try {
        bytes = payload(hit.dir, hit.row);
      } catch (err) {
        // **先记账再返回。** 记的是「哪一条捕获、在哪份档案里」——重新拷贝也好、
        // 重新导入也好，用户要动的是那份档案，光有一个图片 URL 没法定位。
        const captureId = hit.row.capture_id ?? '(index 里没有 capture_id)';
        if (!reported.has(captureId)) {
          reported.add(captureId);
          unreadable.push({
            url: hit.row.url, captureId, dir: hit.dir, error: String(err.message ?? err),
          });
        }
        return null;
      }
      // **写盘放在解压成功之后。** 反过来会在盘上留下一个 0 字节的 .jpg，
      // 而那比没有文件更糟：页面上看起来有图，点开是坏的。
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      written += 1;
    }
    return `${urlPrefix}${rel}`;
  };

  // 先按作品 id 找封面——那是档案里**真的有**的那一张。
  for (const id of wantedBySubject) {
    const hit = index.bySubject.get(id);
    if (!hit) continue;
    const path = write(hit);
    // 取不出来就**不写这一项**。留一个指向不存在文件的路径，页面上是一张碎图；
    // 什么都不写的话走的是「没有封面就只剩文字」那条既定路径。
    if (path) bySubject[id] = path;
  }

  for (const url of wanted) {
    const hit = index.byUrl.get(url);
    if (!hit) {
      // **按 URL 找不到 ≠ 这张图缺了。** 作品封面多半已经被上面那轮按 id 找到了
      // （列表页缩略图与详情页封面是同一张图的两个尺寸）。这里只记录**两条路都
      // 落空**的，否则「缺 95 张」会把一个已经解决的问题天天报给用户看。
      missing.push(url);
      continue;
    }

    const path = write(hit);
    if (path) paths[url] = path;
  }
  releaseSegments();
  return { paths, bySubject, written, missing, unreadable };
}
