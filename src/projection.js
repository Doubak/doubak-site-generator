/**
 * canonical → 投影。
 *
 * ## 投影是缓存，而且是**只读**的缓存
 *
 * CLAUDE.md 里那条硬性规则：**用户的编辑追加到 canonical，任何东西都不写投影**。
 * 投影一旦可写，就有了两个真相来源，「无摩擦导出」这个承诺随即作废。
 *
 * 所以这一层只做一件事：把「一条记录 + 它的全部修订」压成「当前是什么样」。
 * 那是有损的，而且**故意**有损——修订历史留在 canonical 里，随时能重新压一遍。
 *
 * ## 取最后一条修订，但要说清「最后」是什么意思
 *
 * 修订按 `first_observed_at` 升序，所以最后一条是**我们最后一次看到的样子**，
 * 不是「上游现在的样子」。两者的差别在这个项目里很实在：一条被删掉的标记，
 * 投影里仍然是它最后一次被看到的样子——那正是想要的，档案的意义就在这儿。
 */

/**
 * @param {object[]} marks       canonical 的 marks.ndjson
 * @param {object[]} subjects    canonical 的 subjects.ndjson
 * @param {object[]} longform    canonical 的 longform.ndjson
 * @param {object[]} broadcasts  canonical 的 broadcasts.ndjson
 */
export function project({ marks = [], subjects = [], longform = [], broadcasts = [] }) {
  const bySubject = new Map();
  for (const s of subjects) bySubject.set(`${s.medium}:${s.id}`, s);

  const projectedMarks = marks.map((m) => projectMark(m, bySubject.get(`${m.medium}:${m.subject.id}`)));

  return {
    marks: projectedMarks,
    longform: longform.map(projectLongform),
    broadcasts: broadcasts.map((b) => projectBroadcast(b, targetIndex(projectedMarks))),
  };
}

/**
 * 作品 id → 标记，用来把广播接回本地的作品页。
 *
 * **id 撞车的一律不接。** 广播上只有 `data-object-id`，没有媒介；而不同媒介的 id
 * 是各自编号的，理论上会撞。撞了还硬接的话，页面上会出现一条指向另一部作品的链接
 * ——**那比不接严重得多**：不接只是少个链接，接错了是档案在说假话，而且看不出来。
 */
function targetIndex(projectedMarks) {
  /** @type {Map<string, object|null>} null = 撞车了，不许接 */
  const out = new Map();
  for (const m of projectedMarks) {
    if (out.has(m.subjectId)) out.set(m.subjectId, null);
    else out.set(m.subjectId, m);
  }
  return out;
}

/**
 * 一条广播。
 *
 * 广播是这套档案里**最不可替代**的东西：发布即冻结、可以被静默删除，所以每条都是
 * 「那一刻这句话是什么样」的带日期快照。标记页上的短评会被后来的编辑覆盖，广播里
 * 的不会。
 */
function projectBroadcast(b, targets) {
  const r = b.revisions[b.revisions.length - 1];
  const f = r.fields;
  const target = f.target_id ? (targets.get(f.target_id) ?? null) : null;

  return {
    kind: 'broadcast',
    id: b.upstream_id,
    url: b.url ?? null,
    postedAt: f.posted_at?.iso ?? null,
    postedAtRaw: f.posted_at?.raw ?? null,
    text: f.text ?? null,
    action: f.action ?? null,
    status: f.status ?? null,
    targetId: f.target_id ?? null,
    // 接得回本地作品页的才接。接不回来的（撞车、或者那个作品根本没被标记过）
    // 保持 null——宁可少一个链接。
    target: target ? { medium: target.medium, subjectId: target.subjectId, title: target.title } : null,
    images: f.images ?? [],
    lastSeenAt: r.last_observed_at,
  };
}

/** 最后一条修订。**不是**「最新的上游状态」，是「我们最后一次看到的样子」。 */
const latest = (rec) => rec.revisions[rec.revisions.length - 1];

function projectMark(m, subject) {
  const r = latest(m);
  const s = subject ? latest(subject) : null;

  return {
    kind: 'mark',
    medium: m.medium,
    subjectId: m.subject.id,
    url: m.subject.url ?? null,

    // 上游条目被删时作品名是 null——页面上那句「未知电影」是豆瓣的占位符，不是名字。
    // 投影层**不许**拿它填空：那会让占位符一路传到页面标题、外部检索、导出文件里。
    title: s?.fields?.title ?? null,
    upstreamDeleted: Boolean(m.subject.upstream_deleted),
    coverUrl: realCover(s?.fields?.cover_url),
    rawMeta: s?.fields?.raw_meta ?? null,

    status: r.fields.status,
    rating: r.fields.rating ?? null,
    comment: r.fields.comment ?? null,
    tags: r.fields.tags ?? [],
    markedAt: r.fields.marked_at?.iso ?? null,
    markedAtRaw: r.fields.marked_at?.raw ?? null,

    // 有多少个版本，以及我们最后一次看到它是什么时候。**这两个数是投影里唯一
    // 保留的历史痕迹**——不是为了展示，是为了让人知道「这条还有更多东西，去看
    // canonical」。把历史整个抹掉的话，投影会显得像是全部真相。
    revisionCount: m.revisions.length,
    lastSeenAt: r.last_observed_at,
  };
}

function projectLongform(rec) {
  const r = latest(rec);
  return {
    kind: rec.kind, // note | review
    id: rec.upstream_id,
    url: rec.url ?? null,
    title: r.fields.title ?? null,
    body: r.fields.body ?? null,
    publishedAt: r.fields.published_at?.iso ?? null,
    publishedAtRaw: r.fields.published_at?.raw ?? null,
    location: r.fields.location ?? null,
    rating: r.fields.rating ?? null,
    subjectUrl: r.fields.subject_url ?? null,
    revisionCount: rec.revisions.length,
    lastSeenAt: r.last_observed_at,
  };
}

/**
 * 按媒介与状态分组，供首页用。
 *
 * **不算百分比，也不写「完整」。** 完整性的证据在 bundle 的 `crawl_state` 里，
 * 投影这一层没有资格复述一个可能过期的结论（与 coverage 那条同一个理由）。
 *
 * @param {object[]} projectedMarks
 */
export function groupMarks(projectedMarks) {
  /** @type {Map<string, Map<string, object[]>>} */
  const out = new Map();
  for (const m of projectedMarks) {
    if (!out.has(m.medium)) out.set(m.medium, new Map());
    const byStatus = out.get(m.medium);
    if (!byStatus.has(m.status)) byStatus.set(m.status, []);
    byStatus.get(m.status).push(m);
  }
  // 每组内按标记时间倒序——没有时间的排最后，而不是当成 1970 年排最前。
  for (const byStatus of out.values()) {
    for (const list of byStatus.values()) {
      list.sort((a, b) => {
        if (!a.markedAt && !b.markedAt) return 0;
        if (!a.markedAt) return 1;
        if (!b.markedAt) return -1;
        return a.markedAt < b.markedAt ? 1 : -1;
      });
    }
  }
  return out;
}

/**
 * 豆瓣的「暂无封面」占位图当成没有封面。
 *
 * 与「上游被删时作品名保持 null」是同一条规则：**占位符不是内容**。
 * `/cuphead/` 与 `/f/` 是豆瓣的前端静态资源目录，抓取时刻意不存（那不是内容，
 * 而且每个没海报的作品都是同一张）。原样带过去的话，页面上会留一个指向
 * doubanio 的 URL——那让一份号称离线可看的备份，为了一张本来就不存在的图去联网。
 *
 * @param {string|null|undefined} url
 */
function realCover(url) {
  if (!url) return null;
  return /\/(cuphead|f)\//.test(url) ? null : url;
}
