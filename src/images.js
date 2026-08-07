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
  /** @type {Map<string, {dir: string, row: object}>} */
  const out = new Map();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let idxName;
    try {
      idxName = readdirSync(dir).find((f) => f.startsWith('index-') && f.endsWith('.ndjson'));
    } catch { continue; }
    if (!idxName) continue;

    for (const line of readFileSync(join(dir, idxName), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.surface !== 'asset' || row.verdict !== 'ok') continue;
      // 同一张图可能在多份档案里都有。**留最新的那条**——它们字节相同（sha256 会
      // 证明），但取新的能少读一个旧的大段文件。
      out.set(row.url, { dir, row });
    }
  }
  return out;
}

/** 从 Content-Type 推一个扩展名。认不出来就用 .bin —— 不猜。 */
function extOf(contentType) {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[ct] ?? '.bin';
}

/**
 * 文件名取 URL 的最后一段。
 *
 * 豆瓣的图片名本来就是内容哈希一样的东西（`p742323977.jpg`、`b79771d06053dd7.jpg`），
 * 天然唯一且稳定。**不重新编号**：重新生成之后文件名不变，站点的链接才不会全变。
 *
 * @param {string} url
 */
export function fileNameFor(url, contentType) {
  const base = url.split('?')[0].split('/').pop() || 'image';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return /\.[A-Za-z0-9]{2,5}$/.test(clean) ? clean : clean + extOf(contentType);
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
export function exportImages({ index, wanted, outDir, urlPrefix = '/' }) {
  /** @type {Record<string, string>} */
  const paths = {};
  /** @type {string[]} */
  const missing = [];
  let written = 0;

  for (const url of wanted) {
    const hit = index.get(url);
    if (!hit) { missing.push(url); continue; }

    const sub = hit.row.route_key === 'asset.subject_cover' ? 'covers' : 'uploads';
    const name = fileNameFor(url, hit.row.content_type);
    const rel = `${sub}/${name}`;
    const abs = join(outDir, rel);

    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, payload(hit.dir, hit.row));
      written += 1;
    }
    paths[url] = `${urlPrefix}${rel}`;
  }
  releaseSegments();
  return { paths, written, missing };
}
