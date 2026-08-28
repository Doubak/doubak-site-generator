/**
 * 主流程：canonical + bundle → 一个能交给静态站生成器的目录。
 *
 * ## 两个输入，一个都不能少
 *
 * canonical 说「有什么」，bundle 里是图片的字节（canonical 是文本，不装二进制）。
 * 两者都在本地，所以**整个过程零网络请求**——站点也是派生数据，那条不变量在这里
 * 同样成立。
 *
 * ## 产出是缓存，可以整个删掉重来
 *
 * 所以每次生成都**先清空再写**。不清的话，上次生成的、这次已经不该存在的页面
 * 会留在那儿——而那种「幽灵页面」在静态站里格外难发现：它有固定链接、能打开、
 * 内容看着也正常，只是早就不在数据里了。
 */

import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';

import { project, groupMarks } from './projection.js';
import {
  markPage, longformPage, markPath, longformPath, doulistPage, doulistPath, verb,
  broadcastMonthPage, broadcastMonthPath, monthOf,
  markFilterPath, markFilterPage, broadcastBlock, plainText, coverStripItem,
  sectionIndexPath, sectionIndexPage,
} from './markdown.js';
import { indexImages, exportImages, reallyMissing } from './images.js';
import { buildSearchIndex } from './search.js';
import { frontMatter } from './yaml.js';import { buildPages } from './pages.js';

/**
 * @param {object} opts
 * @param {{marks: object[], subjects: object[], longform: object[], broadcasts: object[], doulists?: object[]}} opts.canonical
 * @param {string} [opts.bundlesDir] 有它才导出图片
 * @param {string} opts.outDir
 * @param {boolean} [opts.clean] 先清空产出目录，默认 true
 * @param {string|null} [opts.themeDir] 一并拷进去的 Hugo 站点骨架；null = 只出 content/static
 */
export function generate({ canonical, bundlesDir, outDir, clean = true, themeDir = null }) {
  const p = project(canonical);

  if (clean) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'content'), { recursive: true });

  // ── 图片
  let paths = {};
  /** @type {Record<string, string>} 作品 id → 本地封面路径 */
  let coverBySubject = {};
  let imageStats = { written: 0, missing: [] };
  if (bundlesDir) {
    const wanted = new Set();
    for (const m of p.marks) if (m.coverUrl) wanted.add(m.coverUrl);
    // 正文里内嵌的图：它们在正文文本里以 URL 出现，所以扫一遍正文。
    for (const r of p.longform) {
      for (const m of (r.body ?? '').matchAll(/https:\/\/[a-z0-9.]*doubanio\.com\/[^\s"'<>)）]+/g)) {
        wanted.add(m[0]);
      }
    }
    // 广播附图。这些是**用户自己上传的**，比封面更不可替代——封面豆瓣还有一份，
    // 这些没有第二处。
    for (const b of p.broadcasts) for (const u of b.images) wanted.add(u);
    const res = exportImages({
      index: indexImages(bundlesDir),
      wanted,
      // **按作品 id 再找一遍封面。** canonical 里的 cover_url 取自列表页缩略图，
      // 而档案里存的是详情页封面——多数媒介两者恰好同一个文件，舞台剧那种不是。
      // 只按 URL 找会漏掉 95 张明明就在档案里的图。
      wantedBySubject: new Set(p.marks.map((m) => m.subjectId)),
      outDir: join(outDir, 'static'),
    });
    paths = res.paths;
    coverBySubject = res.bySubject;
    // 按 URL 找不到、但按作品 id 找到了的，不算缺——那是同一张图的两个尺寸。
    // 不筛掉的话「缺 95 张」会成为一条永远存在、且已经不成立的告警，
    // 而一条天天出现的假告警会让真的那条也被忽略。
    const coveredUrls = new Set(
      p.marks.filter((m) => res.bySubject[m.subjectId] && m.coverUrl).map((m) => m.coverUrl),
    );
    imageStats = {
      written: res.written,
      // 占位图也不算缺。`/cuphead/`、`/f/` 是豆瓣的前端静态资源目录，抓取时就
      // **刻意不存**（那不是内容，而且每个没海报的作品都是同一张）。剩下的 6 张
      // 正是墓碑作品——它们本来就没有封面。
      //
      // 这一条与上面那条是同一个意思：**告警要么是真的，要么就不该出现。**
      // 一条永远在的假告警会让真的那条也被忽略。
      missing: res.missing.filter((u) => reallyMissing(u, coveredUrls)),
      // 下面那一轮页面生成时填。
      remote: [],
    };
  }
  // ── 页面。**排页面这件事在 pages.js 里**，那是一个纯函数，扩展也在用同一份。
  // 这里只做它做不了的两件事：把图片字节从 WARC 里搬出来，和把文本写到盘上。
  const built = buildPages(p, { images: paths, coverBySubject });
  const { files, remote, search } = built;

  // ── 可选：把那个最小 Hugo 骨架一并拷进去，让产出目录直接 `hugo server` 就能跑
  //
  // **先拷骨架，后写 content**——反过来的话，骨架里万一带了 content/ 会盖掉刚生成的。
  // 现在骨架里没有 content/，但这个顺序不该依赖「现在恰好没有」。
  let theme = null;
  if (themeDir && existsSync(themeDir)) {
    cpSync(themeDir, outDir, { recursive: true });
    theme = themeDir;
  }

  for (const [rel, text] of files) {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf-8');
  }

  return {
    ...built.stats,
    // **按字节算，不按 .length 算。** JS 的字符串长度是 UTF-16 码元数，
    // 一个汉字算 1，而它在 UTF-8 里是 3 个字节——索引里绝大部分是中文，
    // 用 .length 报出来会少算三分之二。
    searchBytes: Buffer.byteLength(search.js, 'utf-8'),
    // 真去压一遍，不去猜一个比例。传输量是用户唯一在意的数，
    // 而 484 KB 猜成 179 KB 与实际的 266 KB 差着 50%。
    searchGzip: gzipSync(Buffer.from(search.js, 'utf-8')).length,
    theme,
    images: { ...imageStats, remote },
  };
}
