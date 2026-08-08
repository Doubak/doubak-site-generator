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
  const body = m.comment ? `${m.comment}\n` : '';
  return frontMatter(fm) + (body ? `\n${body}` : '');
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
    if (b.action) {
      const t = b.target;
      out.push(t && t.title
        ? `${b.action} [${t.title}](/${t.medium}/${t.subjectId}/)`
        : b.action);
      out.push('');
    }

    if (b.text) out.push(b.text, '');
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
