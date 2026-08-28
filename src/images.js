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
    let idxName;
    try {
      idxName = readdirSync(dir).find((f) => f.startsWith('index-') && f.endsWith('.ndjson'));
    } catch { continue; }
    if (!idxName) continue;
    const rows = [];
    for (const line of readFileSync(join(dir, idxName), 'utf-8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
    bundles.push({ host: dir, rows });
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
  const raw = gunzipSync(seg.subarray(row.offset, row.offset + row.length));
  const headEnd = raw.indexOf(SEP);
  const warcHead = raw.subarray(0, headEnd).toString('utf-8');
  const len = Number(/^Content-Length: (\d+)$/m.exec(warcHead)[1]);
  const block = raw.subarray(headEnd + SEP.length, headEnd + SEP.length + len);
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
 * @returns {{paths: Record<string,string>, written: number, missing: string[]}}
 *   `missing` 是**档案里没有的**图。它们不该被静默忽略：那意味着站点上会缺一张图，
 *   而缺的原因（那次抓取被拦下了 / 那条路线还没做）是用户该知道的。
 */
export function exportImages({ index, wanted, wantedBySubject = new Map(), outDir, urlPrefix = '/' }) {
  /** @type {Record<string, string>} */
  const paths = {};
  /** @type {Record<string, string>} */
  const bySubject = {};
  /** @type {string[]} */
  const missing = [];
  let written = 0;

  const write = (hit) => {
    const sub = subdirFor(hit.row);
    const rel = `${sub}/${fileNameFor(hit.row.url, hit.row.content_type)}`;
    const abs = join(outDir, rel);
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, payload(hit.dir, hit.row));
      written += 1;
    }
    return `${urlPrefix}${rel}`;
  };

  // 先按作品 id 找封面——那是档案里**真的有**的那一张。
  for (const id of wantedBySubject) {
    const hit = index.bySubject.get(id);
    if (hit) bySubject[id] = write(hit);
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

    paths[url] = write(hit);
  }
  releaseSegments();
  return { paths, bySubject, written, missing };
}
