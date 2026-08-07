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
