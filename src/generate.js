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
  markPage, longformPage, markPath, longformPath, verb,
  broadcastMonthPage, broadcastMonthPath, monthOf,
  markFilterPath, markFilterPage,
} from './markdown.js';
import { indexImages, exportImages } from './images.js';
import { buildSearchIndex } from './search.js';
import { frontMatter } from './yaml.js';

/** 媒介的中文名。**唯一的一份**，与扩展那边同源。 */
const MEDIUM_NAMES = {
  movie: '影视', book: '书', music: '音乐', game: '游戏', drama: '舞台剧',
};

/**
 * @param {object} opts
 * @param {{marks: object[], subjects: object[], longform: object[], broadcasts: object[]}} opts.canonical
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
      missing: res.missing.filter((u) => !coveredUrls.has(u) && !/\/(cuphead|f)\//.test(u)),
    };
  }

  // ── 页面
  const files = [];
  for (const m of p.marks) {
    // 按作品 id 找到的优先——那是档案里真的有的那一张。按 URL 找到的作为退路。
    const cover = coverBySubject[m.subjectId] ?? paths[m.coverUrl] ?? null;
    files.push([join('content', markPath(m)), markPage(m, { coverPath: cover })]);
  }
  for (const r of p.longform) {
    files.push([join('content', longformPath(r)), longformPage(r, { images: paths })]);
  }

  /** @type {Map<string, object[]>} 月份 → 该月的广播 */
  const byMonth = new Map();
  for (const b of p.broadcasts) {
    const k = monthOf(b);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(b);
  }
  for (const [month, list] of byMonth) {
    files.push([join('content', broadcastMonthPath(month)), broadcastMonthPage(month, list, { images: paths })]);
  }

  // 每个媒介的每个状态一页（`movie/done/`）。**只给真有条目的状态出页**——
  // 一个「在读 0」的空页会让人以为是页面坏了，而不是「本来就没有」。
  for (const [medium, byStatus] of groupMarks(p.marks)) {
    for (const [status, list] of byStatus) {
      files.push([join('content', markFilterPath(medium, status)), markFilterPage(medium, status, list.length)]);
    }
  }

  files.push(['content/_index.md', homePage(p)]);

  // ── 搜索索引
  //
  // **总是产出，即使不带骨架。** 它是从 canonical 派生的数据，任何 SSG 都能用；
  // 搜索框与结果页才是骨架的事。
  const search = buildSearchIndex(p);
  files.push(['static/search-index.js', search.js]);
  // 搜索页本身要有个 content 文件，Hugo 才会渲染它。
  files.push(['content/search.md', searchPage(search.rows.length)]);

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
    pages: files.length,
    marks: p.marks.length,
    longform: p.longform.length,
    broadcasts: p.broadcasts.length,
    broadcastMonths: byMonth.size,
    searchRows: search.rows.length,
    // **按字节算，不按 .length 算。** JS 的字符串长度是 UTF-16 码元数，
    // 一个汉字算 1，而它在 UTF-8 里是 3 个字节——索引里绝大部分是中文，
    // 用 .length 报出来会少算三分之二。
    searchBytes: Buffer.byteLength(search.js, 'utf-8'),
    // 真去压一遍，不去猜一个比例。传输量是用户唯一在意的数，
    // 而 484 KB 猜成 179 KB 与实际的 266 KB 差着 50%。
    searchGzip: gzipSync(Buffer.from(search.js, 'utf-8')).length,
    theme,
    images: imageStats,
  };
}

/**
 * 首页。
 *
 * **只给数字，不给百分比，也不写「完整」。** 完整性的证据在 bundle 的 `crawl_state`
 * 里，投影这一层没有资格复述一个可能已经过期的结论——那与「coverage 不是完整性
 * 判据」是同一条规则。
 */
function homePage(p) {
  const groups = groupMarks(p.marks);
  const lines = [];

  for (const [medium, byStatus] of [...groups].sort()) {
    lines.push(`## ${MEDIUM_NAMES[medium] ?? medium}`, '');
    for (const [status, list] of [...byStatus].sort()) {
      // **链到文件，不写死固定链接。** 与正文里的作品交叉链接同一条规则：
      // 生成器只说「那份内容在这个文件里」，最终 URL 由 SSG 决定——第一版写死
      // `/movie/123/` 的那次，打开 uglyURLs 就全断了。
      lines.push(`- [${verb(medium, status)} ${list.length}](${markFilterPath(medium, status)})`);
    }
    lines.push('');
  }

  const withText = p.broadcasts.filter((b) => b.text).length;
  if (p.broadcasts.length) {
    lines.push(
      '## 广播', '',
      `- 共 ${p.broadcasts.length} 条，其中 ${withText} 条带正文`,
      // **广播发布即冻结。** 这不是一句介绍，是这份档案里唯一能证明
      // 「首次抓取之前发生过编辑」的东西——标记页上的短评会被后来的编辑覆盖。
      '- 广播发布后不可编辑，所以每条都是那一刻的原话',
      '',
    );
  }

  const notes = p.longform.filter((r) => r.kind === 'note').length;
  const reviews = p.longform.filter((r) => r.kind === 'review').length;
  if (notes || reviews) {
    lines.push('## 长文', '', `- 日记 ${notes}`, `- 评论 ${reviews}`, '');
  }

  const deleted = p.marks.filter((m) => m.upstreamDeleted).length;
  if (deleted) {
    lines.push(
      '## 上游已删除',
      '',
      `有 ${deleted} 条标记指向豆瓣已经删掉的作品。标记本身还在——评分、标签、`
      + '短评都是你自己写的，它们没有跟着消失。',
      '',
    );
  }

  return frontMatter({ title: '我的豆瓣存档', douban_kind: 'index' }) + '\n' + lines.join('\n');
}

/**
 * 搜索页。正文是空的——结果由骨架里的脚本填。
 *
 * `layout: search` 让 Hugo 去找 `layouts/_default/search.html`。别的 SSG 认不认
 * 这个键无所谓：认不出来它就是一个空页面，而索引文件仍然在那儿可以自己用。
 */
function searchPage(n) {
  return frontMatter({
    title: '搜索',
    layout: 'search',
    douban_kind: 'search',
    douban_count: n,
  });
}
