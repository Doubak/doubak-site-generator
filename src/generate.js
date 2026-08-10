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
  markFilterPath, markFilterPage, broadcastBlock, plainText,
  sectionIndexPath, sectionIndexPage,
} from './markdown.js';
import { indexImages, exportImages } from './images.js';
import { buildSearchIndex } from './search.js';
import { frontMatter } from './yaml.js';

/** 媒介的中文名。**唯一的一份**，与扩展那边同源。 */
const MEDIUM_NAMES = {
  movie: '影视', book: '书', music: '音乐', game: '游戏', drama: '舞台剧',
  // 首页把广播与长文也当成小节来排，所以这三个名字也在这儿。
  // 主题那边 `hugo.toml` 的 `[params.mediumNames]` 是同一份，测试钉着两处相等。
  broadcast: '广播', note: '日记', review: '评论',
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
      // 下面那一轮页面生成时填。
      remote: [],
    };
  }

  // ── 页面
  const files = [];

  /**
   * 最后仍然指向 doubanio 的图。
   *
   * **这是这份档案唯一会悄悄失去「离线可看」的地方。** 没导出到本地的图，页面上
   * 保留的是原始 URL——那条选择本身是有理由的（留一个 URL 至少说明「这儿本来有
   * 张图」，比悄悄删掉一张图好），但它的代价必须**说出来**：那一张图从此需要豆瓣
   * 还活着才看得见，而这个项目存在的全部理由就是不再需要那个前提。
   *
   * 原来这件事完全不报。CLI 只说「档案里没有的图 N 张（页面上会缺）」——**而那句
   * 话是错的**：它们不会缺，它们会去豆瓣取。两种结果的性质差得远，说错了的那句
   * 反而让人以为已经知道后果了。
   * @type {string[]}
   */
  const remote = [];
  /** @param {string|null|undefined} url */
  const stillRemote = (url) => { if (url && !paths[url]) remote.push(url); };

  for (const m of p.marks) {
    // 按作品 id 找到的优先——那是档案里真的有的那一张。按 URL 找到的作为退路。
    const cover = coverBySubject[m.subjectId] ?? paths[m.coverUrl] ?? null;
    if (!cover) stillRemote(m.coverUrl);
    files.push([join('content', markPath(m)), markPage(m, { coverPath: cover })]);
  }
  for (const r of p.longform) {
    for (const m of (r.body ?? '').matchAll(/https:\/\/[a-z0-9.]*doubanio\.com\/[^\s"'<>)）]+/g)) {
      stillRemote(m[0]);
    }
    files.push([join('content', longformPath(r)), longformPage(r, { images: paths })]);
  }

  /** @type {Map<string, object[]>} 月份 → 该月的广播 */
  const byMonth = new Map();
  for (const b of p.broadcasts) {
    const k = monthOf(b);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(b);
    for (const u of b.images) stillRemote(u);
  }
  // 作品 id → 本地封面路径。广播里「看过 X」那一行要配一张小封面，与豆瓣一样。
  // **用的是标记页那套同一个查法**（先按作品 id，再按 URL 退一步），不另写一份：
  // 两份查法迟早会分叉，而分叉的样子是「有些广播有封面、有些没有」，看起来像数据缺。
  /** @type {Record<string, string>} */
  const covers = {};
  for (const m of p.marks) {
    const c = coverBySubject[m.subjectId] ?? paths[m.coverUrl] ?? null;
    if (c) covers[m.subjectId] = c;
  }

  for (const [month, list] of byMonth) {
    files.push([join('content', broadcastMonthPath(month)), broadcastMonthPage(month, list, { images: paths, covers })]);
  }

  // 每个媒介的每个状态一页（`movie/done/`）。**只给真有条目的状态出页**——
  // 一个「在读 0」的空页会让人以为是页面坏了，而不是「本来就没有」。
  for (const [medium, byStatus] of groupMarks(p.marks)) {
    for (const [status, list] of byStatus) {
      files.push([join('content', markFilterPath(medium, status)), markFilterPage(medium, status, list.length)]);
    }
  }

  // 广播 / 日记 / 评论各自的小节页。**首页那句「看全部 →」要有文件可链**——
  // 没有这个文件时 Hugo 会造一个空小节页，而 Markdown 里链不到一个不存在的文件。
  for (const [section, has] of [
    ['broadcast', p.broadcasts.length > 0],
    ['note', p.longform.some((r) => r.kind === 'note')],
    ['review', p.longform.some((r) => r.kind === 'review')],
  ]) {
    if (has) {
      files.push([join('content', sectionIndexPath(section)),
        sectionIndexPage(section, MEDIUM_NAMES[section] ?? section)]);
    }
  }

  files.push(['content/_index.md', homePage(p, { covers, previewImages: paths })]);

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
    images: { ...imageStats, remote: [...new Set(remote)] },
  };
}

/**
 * 首页。
 *
 * **只给数字，不给百分比，也不写「完整」。** 完整性的证据在 bundle 的 `crawl_state`
 * 里，投影这一层没有资格复述一个可能已经过期的结论——那与「coverage 不是完整性
 * 判据」是同一条规则。
 */
/**
 * 首页各小节的顺序。**与页眉导航同一份顺序**（主题那边是 `hugo.toml` 的
 * `sectionOrder`），两处对不上比顺序不对更难发现。`test/pages.test.js` 钉着它们相等。
 *
 * 不按字母序：广播是这份存档里最不可替代的一条（发布即冻结、可被静默删除），排第一；
 * 日记与评论只有个位数，排后面。
 */
const SECTION_ORDER = ['broadcast', 'book', 'movie', 'game', 'music', 'drama', 'note', 'review'];

/**
 * 标记状态在页面上的先后。
 *
 * **想看 → 在看 → 看过**，跟着事情本身的次序走。字母序（doing/done/wish）读出来是
 * 「在看、看过、想看」，那是把内部标识的排序当成了人的顺序。
 */
const STATUS_ORDER = ['wish', 'doing', 'done'];

/** 首页每一行摆几张封面。摆不下的由主题裁掉——一行就是一行。 */
const STRIP = 12;

/** 广播、日记、评论各给几条预览。 */
const PREVIEW = 2;

/** 长文预览截多少字。 */
const EXCERPT = 80;

/**
 * 首页。
 *
 * ## 它是一份概览，不是一张目录
 *
 * 原来这里只有一列数字（「读过 45」），点进去才看得到东西。而这份存档的价值恰恰在
 * 那些封面、那些话——首页一张图都没有的话，它看起来像个后台管理界面。
 *
 * 所以每个状态给一行封面加一个「看全部」的出口；广播与长文各给两条真实的预览。
 *
 * ## 还是纯 Markdown
 *
 * 一行封面就是若干个 `[![标题](封面)](作品页.md)` 排在同一行里——与广播附图同一个
 * 写法。**版式交给主题**：一行放得下几张、多出来的怎么裁，都是 CSS 的事。
 * 正文里不塞 HTML（塞了就得开 `unsafe`，那等于让用户文本里的 HTML 在 Pages 上执行）。
 *
 * ## 只给数字，不给百分比，也不写「完整」
 *
 * 完整性的证据在 bundle 的 `crawl_state` 里，而豆瓣的计数有时算在它的审查层之前、
 * 有时之后。投影这一层没有资格复述一个可能已经过期的结论。
 *
 * @param {object} p 投影
 * @param {{covers?: Record<string, string>}} [opts] 作品 id → 本地封面路径
 */
function homePage(p, { covers = {}, previewImages = {} } = {}) {
  const groups = groupMarks(p.marks);
  const lines = [];

  /**
   * 一行封面，写成一个 **Markdown 列表**。
   *
   * 不写成一段并排的图片：广播预览那一行也是「一个 `<p>` 里有 `<a><img>`」，
   * 两者在 CSS 里就分不开了——而它们该有的大小差着一倍。列表给了一个纯 Markdown
   * 的结构区分（`<ul><li>` vs `<p>`），任何 SSG 下都成立，也不用往正文里塞 HTML。
   *
   * 没有封面的作品不占位——占位符不是内容。
   */
  const strip = (list) => list
    .filter((m) => covers[m.subjectId])
    .slice(0, STRIP)
    .map((m) => `- [![${plainText(m.title ?? '')}](${covers[m.subjectId]})](${markPath(m)})`);

  /** 按想要的顺序排，**名单之外的接在后面**——一个都不许丢。 */
  const order = (keys, want) => [
    ...want.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !want.includes(k)).sort(),
  ];

  /** 一个媒介：标题 + 每个状态一行封面 + 出口。 */
  const mediumSection = (medium) => {
    const byStatus = groups.get(medium);
    const total = [...byStatus.values()].reduce((n, l) => n + l.length, 0);
    const out = [`## ${MEDIUM_NAMES[medium] ?? medium} ${total}`, ''];
    for (const status of order([...byStatus.keys()], STATUS_ORDER)) {
      const list = byStatus.get(status);
      out.push(`### ${verb(medium, status)} ${list.length}`, '');
      const row = strip(list);
      if (row.length) out.push(...row, '');
      // **链到文件，不写死固定链接。** 与正文里的作品交叉链接同一条规则：
      // 生成器只说「那份内容在这个文件里」，最终 URL 由 SSG 决定——第一版写死
      // `/movie/123/` 的那次，打开 uglyURLs 就全断了。
      out.push(`[看全部 ${list.length} →](${markFilterPath(medium, status)})`, '');
    }
    return out;
  };

  /** 广播：两条真实的预览。只写「共 3401 条」等于把这份档案最值钱的东西藏起来。 */
  const broadcastSection = () => {
    const recent = [...p.broadcasts]
      .sort((a, b) => ((a.postedAt ?? '') < (b.postedAt ?? '') ? 1 : -1))
      .slice(0, PREVIEW);
    const withText = p.broadcasts.filter((b) => b.text).length;
    return [
      `## ${MEDIUM_NAMES.broadcast} ${p.broadcasts.length}`, '',
      `其中 ${withText} 条带正文。广播发布后不可编辑，所以每条都是那一刻的原话。`, '',
      // **首页就在根上，前缀是空**；月页在 broadcast/ 底下才要 `../`。
      ...recent.map((b) => broadcastBlock(b, { images: previewImages, covers, linkPrefix: '' })),
      '',
      `[看全部 ${p.broadcasts.length} 条 →](${sectionIndexPath('broadcast')})`, '',
    ];
  };

  /** 日记 / 评论：两篇预览，正文只给开头。 */
  const longformSection = (kind) => {
    const list = p.longform.filter((r) => r.kind === kind);
    const recent = [...list]
      .sort((a, b) => ((a.publishedAt ?? '') < (b.publishedAt ?? '') ? 1 : -1))
      .slice(0, PREVIEW);
    const out = [`## ${MEDIUM_NAMES[kind]} ${list.length}`, ''];
    for (const r of recent) {
      out.push(`### [${plainText(r.title ?? '(无标题)')}](${longformPath(r)})`, '');
      const when = r.publishedAtRaw ?? (r.publishedAt ?? '').slice(0, 10);
      if (when) out.push(`*${when}*`, '');
      // 正文只给开头一小段，**并且把截断说出来**。不说的话读者无从分辨这是全文还是
      // 摘要——而「半截当全文」在这份档案里是明令禁止的（见广播的 text_truncated）。
      // 图片标记去掉，空白压成一个空格：摘要是一段话，不是一小块排版。
      const flat = (r.body ?? '').replace(/!\[\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      const chars = [...flat];
      if (chars.length) {
        out.push(plainText(chars.slice(0, EXCERPT).join('')) + (chars.length > EXCERPT ? '……' : ''), '');
      }
    }
    out.push(`[看全部 ${list.length} 篇 →](${sectionIndexPath(kind)})`, '');
    return out;
  };

  // **所有小节排在同一个顺序里**，不是「先媒介、再把广播长文接在后面」——
  // 那样广播永远垫底，而它恰恰是这份档案里最不可替代的一条。
  const present = [
    ...(p.broadcasts.length ? ['broadcast'] : []),
    ...groups.keys(),
    ...(p.longform.some((r) => r.kind === 'note') ? ['note'] : []),
    ...(p.longform.some((r) => r.kind === 'review') ? ['review'] : []),
  ];
  for (const section of order(present, SECTION_ORDER)) {
    if (section === 'broadcast') lines.push(...broadcastSection());
    else if (section === 'note' || section === 'review') lines.push(...longformSection(section));
    else lines.push(...mediumSection(section));
  }

  const deleted = p.marks.filter((m) => m.upstreamDeleted).length;
  if (deleted) {
    lines.push(
      '## 上游已删除', '',
      `有 ${deleted} 条标记指向豆瓣已经删掉的作品。标记本身还在——评分、标签、`
      + '短评都是你自己写的，它们没有跟着消失。', '',
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
