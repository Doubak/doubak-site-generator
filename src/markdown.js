/**
 * 投影 → Markdown + YAML front matter。
 *
 * ## 不做模板引擎
 *
 * CLAUDE.md 里定死的：产出 Markdown，交给 Hugo / Astro / Eleventy / Jekyll 渲染，
 * **每一个现成的主题生态都变成模板库**。自己写一个模板引擎意味着要重新发明布局、
 * 分页、RSS、搜索——而那些东西早就有人做得比我们好。
 *
 * 代价是 front matter 的字段名要在几个 SSG 之间取个公约数。取法是：
 * **用它们都认的那几个（title / date / tags / draft），其余一律加 `douban_` 前缀**，
 * 免得撞上主题自己的约定。
 */

import { frontMatter } from './yaml.js';

/** 豆瓣的动词跟着媒介走。「看过一本书」是错的说法，所以这个映射不能省。 */
const VERB = {
  movie: { done: '看过', doing: '在看', wish: '想看' },
  book: { done: '读过', doing: '在读', wish: '想读' },
  music: { done: '听过', doing: '在听', wish: '想听' },
  game: { done: '玩过', doing: '在玩', wish: '想玩' },
  drama: { done: '看过', doing: '在看', wish: '想看' },
};

/** @param {string} medium @param {string} status */
export function verb(medium, status) {
  return VERB[medium]?.[status] ?? status;
}

/**
 * 一条标记 → 一个 md 文件。
 *
 * @param {object} m 投影后的标记
 * @param {{coverPath?: string|null}} [opts] `coverPath` 是导出到本地之后的路径
 */
export function markPage(m, { coverPath = null } = {}) {
  const fm = {
    // ── SSG 通用的几个
    //
    // 作品名可能是 null（上游条目被删）。**不拿占位符顶替**，而是如实写成
    // 「未知作品」加上 douban_upstream_deleted=true，让主题自己决定怎么显示。
    title: m.title ?? `未知${m.medium === 'book' ? '图书' : '作品'}`,
    date: m.markedAt ?? null,
    tags: m.tags ?? [],

    // ── 其余全部加前缀，免得撞上主题的约定
    douban_kind: 'mark',
    douban_medium: m.medium,
    douban_status: m.status,
    douban_verb: verb(m.medium, m.status),
    douban_rating: m.rating,
    douban_subject_id: m.subjectId,
    douban_url: m.url,
    douban_marked_at_raw: m.markedAtRaw,
    douban_upstream_deleted: m.upstreamDeleted,
    // 那一行无标签的元信息，原样带过来。**不在这里拆**——理由见 canonical/FIELDS.md：
    // 实测电影 2090 条里出现过 43 种段数，按位置拆多数行都是错的；按内容猜属于
    // enricher，它的产出带 source 与置信度、可以重跑。
    douban_meta: m.rawMeta,
    douban_cover: coverPath ?? m.coverUrl,
    // 留一条通往 canonical 的线索：投影是有损的，这两个数说明「还有更多」。
    douban_revisions: m.revisionCount,
    douban_last_seen: m.lastSeenAt,
  };

  // 正文只放用户自己写的短评。**没有短评就是空正文**，不编一句「暂无短评」——
  // 那会让「没写」和「写了但抓不到」在页面上长得一样。
  const body = m.comment ? `${plainText(m.comment)}\n` : '';
  return frontMatter(fm) + (body ? `\n${body}` : '') + timelineSection(m);
}

/**
 * 「什么时候 → 说了什么」。
 *
 * ## 为什么这一段值得单独存在
 *
 * 标记页上只剩**最新**那条短评——改一次覆盖一次，豆瓣不留历史。而广播是冻结的，
 * 带秒级时间戳，所以它保住了标记页上早就没有的话。实测：标记自己的修订历史只
 * 覆盖 3 条，广播里却有 342 条与当前短评不同的发言，涉及 305 个作品。
 *
 * ## 每一条都标出处，不只在「拿不准」的时候
 *
 * 因为两个来源的性质本来就不同，而这个差别是读者该知道的：
 *
 *     广播   发布即冻结，秒级 —— 「那一刻这句话就是这样」
 *     标记   可编辑，只到天   —— 「我们某次抓取时看到的样子」
 *
 * ## 不说「改过」
 *
 * 实测那 342 条里 305 条是**状态推进**（想看时说一句，看过之后又说一句），
 * 只有 15 条是同一状态下说了别的。把它们呈现成「检测到编辑」，89% 都是冤枉的
 * ——那就是档案在说假话。所以这里只按时间列出来，判断留给读者。
 *
 * @param {object} m
 */
function timelineSection(m) {
  const rows = m.timeline ?? [];
  // 什么时候这一段没有信息量：**只有一条，而且它是标记自己那条**——
  // 正文里已经有短评，front matter 里已经有日期，再列一遍是噪音。
  //
  // 但只要那一条来自广播，它就带来了正文里没有的东西：**准确到秒的时间**。
  // 标记页上只有天（`douban_marked_at_raw`），而「2026-07-19 19:18:39」这种
  // 精度只有广播给得出——丢掉它，就等于把广播这条路线最值钱的性质扔了。
  if (rows.length === 0) return '';
  if (rows.length === 1 && rows[0].source !== 'broadcast') return '';

  const out = ['', '## 说过什么', ''];
  for (const r of rows) {
    const when = r.atRaw ?? (r.at ?? '').slice(0, 10) ?? '时间不详';
    // 动作可能没有（纯发言的广播就没有）。**没有就不要留一个悬着的「·」**——
    // 那看起来像少了点什么，而其实是本来就没有。
    const act = r.source === 'broadcast'
      ? (r.action || (r.status ? verb(m.medium, r.status) : ''))
      : verb(m.medium, r.status);
    const label = r.source === 'broadcast' ? '广播' : '标记';
    // 时间与短评来自不同来源时要说清楚。不说的话，「广播 · 玩过」加一段短评
    // 会被读成「那条广播里写着这句话」——而广播里其实什么都没写，那句短评
    // 在标记页上。
    const mixed = r.text && r.textSource && r.textSource !== r.source;
    const what = mixed
      ? `${act || label} · 时间来自${label}，短评来自${r.textSource === 'mark' ? '标记页' : '广播'}`
      : (act ? `${label} · ${act}` : label);
    out.push(`### ${when}`, '', `*${what}*`, '');
    // 没有短评就只有这一行——**不编一句「无短评」**，那会让「没写」和
    // 「写了但抓不到」在页面上长得一样。
    if (r.text) out.push(plainText(r.text), '');
    if (r.truncated) out.push('*（豆瓣在这里截断了）*', '');
  }
  return out.join('\n');
}

/**
 * 一篇日记或评论 → 一个 md 文件。
 *
 * @param {object} r 投影后的长文
 * @param {{images?: Record<string, string>}} [opts] 内嵌图 URL → 本地路径
 */
export function longformPage(r, { images = {} } = {}) {
  const fm = {
    title: r.title ?? '(无标题)',
    date: r.publishedAt ?? null,
    douban_kind: r.kind,
    douban_id: r.id,
    douban_url: r.url,
    douban_published_at_raw: r.publishedAtRaw,
    douban_location: r.location,
    douban_rating: r.rating,
    douban_subject_url: r.subjectUrl,
    douban_revisions: r.revisionCount,
    douban_last_seen: r.lastSeenAt,
  };

  let body = r.body ?? '';
  // 正文里提到的图，换成本地路径。**没导出的就保持原样**——留一个指向 doubanio
  // 的 URL，总比悄悄删掉一张图好：前者至少说明「这儿本来有张图」。
  for (const [url, path] of Object.entries(images)) {
    if (body.includes(url)) body = body.split(url).join(path);
  }
  // 正文里**混着两种东西**：用户写的字，和解析器插进去的 `![](url)` 图片标记。
  // 只能转义前者——把图片标记也转义掉，图就变成一行字面文本了。
  // 所以按图片标记切开，只转义中间那些段。
  body = body
    .split(/(!\[\]\([^)]*\))/)
    .map((seg, i) => (i % 2 === 1 ? seg : plainText(seg)))
    .join('');
  return frontMatter(fm) + (body ? `\n${body}\n` : '');
}

/**
 * 文件名。
 *
 * 用作品 id 而不是标题：**标题会变，也可能是 null，还可能撞名**。id 稳定，
 * 而且让固定链接在重新生成之后不变——那是「有固定链接的个人存档站」的前提。
 *
 * @param {object} m
 */
export function markPath(m) {
  return `${m.medium}/${m.subjectId}.md`;
}

/** @param {object} r */
export function longformPath(r) {
  return `${r.kind}/${r.id}.md`;
}

/**
 * 广播按月归档，一个月一页。
 *
 * ## 为什么不是一条一页
 *
 * 3394 条广播里只有 23% 带正文，其余是纯标记动作（「想看 X」）。一条一页会产出
 * 三千多个只有一行字的文件，把真正有内容的那七百多条埋掉。按月归档保留了广播
 * 本来的形状——**它是一条时间线，不是一堆条目**。
 *
 * 固定链接不丢：每条都有自己的时间戳小标题，SSG 会给它生成锚点，
 * `/broadcast/2021-11/#2021-11-28-202521` 就是那条广播的地址。
 *
 * ## 顺序是倒序的，与豆瓣一致
 *
 * 头插列表，新的在上。这不只是习惯问题：抓取本身就是新→旧走的，倒序让页面
 * 与抓取顺序、与「上面的都抓到了」那个不变量方向一致。
 *
 * @param {string} month  `2021-11`
 * @param {object[]} list 该月的广播，未排序
 * @param {{images?: Record<string, string>}} [opts] 附图 URL → 本地路径
 */
export function broadcastMonthPage(month, list, { images = {} } = {}) {
  const sorted = [...list].sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
  const [y, m] = month.split('-');

  const fm = {
    title: `${y}年${Number(m)}月`,
    // 月首，不是月内某条的时间——这一页代表的是整个月。
    date: `${month}-01`,
    douban_kind: 'broadcast_month',
    douban_month: month,
    douban_count: sorted.length,
    // 带正文的有几条。**这个数才是「这一页有多少自己写的东西」**——
    // 总数里大部分是纯标记动作。
    douban_with_text: sorted.filter((b) => b.text).length,
    douban_images: sorted.reduce((n, b) => n + b.images.length, 0),
  };

  const blocks = sorted.map((b) => {
    const out = [`### ${b.postedAtRaw ?? b.postedAt ?? '时间未知'}`, ''];

    // 动作那一行：「想看 《某电影》」。接得回本地作品页就接，接不回来就只留文字
    // ——**不回退到豆瓣的 URL**，那会让一份号称离线可看的档案去联网。
    //
    // 链接指向**那个 .md 文件的相对路径**，不是某种 URL。
    //
    // 第一版写的是 `/movie/123/`，也就是把一种固定链接方案硬编码进了 Markdown
    // 里——而那个方案是 SSG 的，不是我们的。实测的后果：Hugo 开了 uglyURLs 之后
    // 页面是 `movie/123.html`，那些链接全部指向不存在的目录；在 file:// 下更糟，
    // 浏览器会显示一个目录列表。
    //
    // 相对文件路径没有这个问题：它说的是「那份文件在这儿」，由 SSG 自己去决定
    // 它最终的 URL 长什么样（Hugo 的 link render hook 会把 `.md` 换成实际后缀）。
    // **动作可以没有，链接不该跟着没有。** 第一版把作品链接挂在 `if (b.action)`
    // 里面，于是一条没有动作词、却明确指着某个作品的广播（转发、纯发言）在页面上
    // 与那个作品完全断开——而它的 target_id 就在数据里。实测只影响 1 条，
    // 但断开的理由是「代码结构」而不是「数据没有」，那就是个 bug。
    const t = b.target;
    const link = t && t.title ? `[${t.title}](../${t.medium}/${t.subjectId}.md)` : null;
    if (b.action || link) {
      out.push([b.action, link].filter(Boolean).join(' '), '');
    }

    if (b.text) out.push(plainText(b.text), '');
    // **被截断就说出来。** 显示半截正文而不声明，站点就在替档案说假话。
    // 接得回本地长文页就给个链接（同样用 .md 相对路径，不硬编码 URL 方案）；
    // 接不上就只说被截断了——不回退到豆瓣。
    if (b.textTruncated) {
      out.push(b.fullText
        ? `*（豆瓣在这里截断了，[全文在这篇${b.fullText.kind === 'review' ? '评论' : '日记'}里](../${b.fullText.kind}/${b.fullText.id}.md)）*`
        : '*（豆瓣在这里截断了，全文不在档案里）*', '');
    }
    for (const url of b.images) {
      // 没导出的图保持原样：留一个指向 doubanio 的 URL，总比悄悄删掉一张图好
      // ——前者至少说明「这儿本来有图」。
      out.push(`![](${images[url] ?? url})`, '');
    }
    return out.join('\n');
  });

  return frontMatter(fm) + '\n' + blocks.join('\n');
}

/** @param {string} month `2021-11` */
export function broadcastMonthPath(month) {
  return `broadcast/${month}.md`;
}

/**
 * 一条广播属于哪个月。
 *
 * 按**本地时间**切，不按 UTC。canonical 里的时间戳带 `+08:00`，用 UTC 切的话
 * 每月头几个小时的广播会掉到上一个月去——一个不会报错、只会让归档悄悄错位的 bug。
 *
 * @param {object} b
 */
export function monthOf(b) {
  return (b.postedAtRaw ?? b.postedAt ?? '').slice(0, 7) || '未知';
}

/**
 * 把**用户自己写的字**转义成 Markdown 里的字面文本。
 *
 * ## 为什么非有不可
 *
 * 正文是交给 Markdown 渲染的，而用户写的字里满是 Markdown 的活字符。实测那份
 * 真实档案的 2831 段自撰文本，有 62 段会被悄悄改写，其中两类是真的丢东西：
 *
 *     _(:з」∠)_          → <em>(:з」∠)</em>   下划线被吃掉，整句变斜体（实测 24 处）
 *     From <May December> → From              **整个片名消失**（goldmark 当它是裸 HTML）
 *
 * 第二类尤其严重：页面上什么都不剩，看不出这儿本来有字。**一份会悄悄改写你写过
 * 的话的存档，比没有存档更糟**——它看起来是可信的。
 *
 * ## 为什么不是打开 `unsafe = true`
 *
 * 那会让用户文本里的 HTML 真的执行。广播和日记里到处是别人的名字和内容，而这个
 * 项目还要往 GitHub Pages 上推——把任意 HTML 当标记渲染是往外发布路径上开的口子。
 * 何况那也不对：豆瓣的广播是纯文本，任何 Markdown 解释都是失真。
 *
 * ## 转义策略是量出来的
 *
 * 尖括号与 `&` 用 HTML 实体（反斜杠对它们无效），其余行内记号用反斜杠，块首记号
 * 只在行首转义——`a-b` 里的连字符不该被动，`- item` 里的必须被动。
 *
 * @param {string|null|undefined} s
 * @returns {string} 渲染之后与输入逐字相同的 Markdown
 */
export function plainText(s) {
  if (!s) return '';
  return s
    // 反斜杠必须第一个处理，否则会把后面加的反斜杠又转义一遍。
    .replace(/\\/g, '\\\\')
    // `&` `<` `>` 反斜杠转义无效（CommonMark 只允许转义 ASCII 标点里的特定几个，
    // 而裸 HTML 的识别发生在更早的阶段），必须用实体。
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*_[\]~])/g, '\\$1')
    // 块首记号只在行首有意义。全局转义会把 `a-b` 写成 `a\-b`，源码难看，
    // 而且那个连字符本来就不会被解释成列表。
    .split('\n')
    .map((line) => line
      .replace(/^(\s*)([#+=|-])(\s|$)/, '$1\\$2$3')
      // 有序列表要转义的是**那个点**，不是数字。CommonMark 不允许转义数字，
      // `\1.` 会原样渲染成一个反斜杠加 1 —— 实测确认过。
      .replace(/^(\s*)(\d+)([.)])(\s|$)/, '$1$2\\$3$4'))
    .join('\n');
}
