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
 * @param {object[]} marks     canonical 的 marks.ndjson
 * @param {object[]} subjects  canonical 的 subjects.ndjson
 * @param {object[]} longform  canonical 的 longform.ndjson
 */
export function project({ marks = [], subjects = [], longform = [] }) {
  const bySubject = new Map();
  for (const s of subjects) bySubject.set(`${s.medium}:${s.id}`, s);

  return {
    marks: marks.map((m) => projectMark(m, bySubject.get(`${m.medium}:${m.subject.id}`))),
    longform: longform.map(projectLongform),
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
    coverUrl: s?.fields?.cover_url ?? null,
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
