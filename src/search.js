/**
 * 搜索索引。
 *
 * ## 不建倒排索引
 *
 * 实测这份档案可搜的文本一共 18.5 万字，`String.includes` 全量扫一遍
 * **0.1–0.5 毫秒**——键入即出结果。建索引反而带来三个真问题：
 *
 *   1. 中文没有词边界。分词器在「京阿尼」「奈飞」这种词上会失手，而用户搜的
 *      恰恰是这些。
 *   2. bigram 索引比原文还大。
 *   3. 那是一堆要自己写、自己测、自己维护的代码。
 *
 * **这个规模下朴素扫描不是将就，是正确答案。** 哪天条目涨到十万级再说——那时
 * 有真实数据可以量，而不是现在凭想象优化。
 *
 * ## 产出 `.js` 而不是 `.json`
 *
 * 这是被 `file://` 逼出来的：浏览器在 `file://` 下会拦掉 `fetch` 与 `XHR`
 *（源是 opaque 的），但 `<script>` 标签照常工作。
 *
 * 用 `.json` + `fetch` 的话，站点在 http 下能搜、双击打开就废——而「双击
 * `index.html` 就能看」是这个项目已经守住的性质，不该为搜索破掉。
 *
 * ## 它是数据，不是 Hugo 的东西
 *
 * 所以 `npm run md` 也产出它：任何 SSG 都能拿去用。搜索框与结果页才归骨架。
 */

/**
 * 一条可搜的记录。**键名都很短**——4000 条乘以几个字符，省下来的是实打实的传输量。
 *
 * @typedef {object} SearchRow
 * @property {'m'|'b'|'l'} t  类型：标记 / 广播 / 长文
 * @property {string} u       站内路径，**不带扩展名**（`movie/1292052`）。
 *                            扩展名由消费者补——它取决于 SSG 的固定链接方案，
 *                            而索引不该替 SSG 做这个决定。
 * @property {string|null} n  标题
 * @property {string[]} [a]   又名（台译名 / 港译名 / 原文名）。搜索时最有用的一项。
 * @property {string} [w]     可搜的作品信息：导演、作者、类型等。见 indexedInfo。
 * @property {string} c       正文（短评 / 广播正文 / 长文全文）
 * @property {string} d       时间原文
 * @property {string} [k]     媒介或长文类型
 * @property {string} [s]     标记状态
 */

/**
 * @param {{marks: object[], longform: object[], broadcasts: object[]}} p 投影
 * @returns {{rows: SearchRow[], js: string}}
 */
export function buildSearchIndex(p) {
  /** @type {SearchRow[]} */
  const rows = [];

  for (const m of p.marks) {
    // **没有标题也要收。** 上游被删的作品标题是 null，而用户自己写的短评
    // 还在——那恰恰是最该搜得到的东西。
    /** @type {SearchRow} */
    const row = {
      t: 'm',
      u: `${m.medium}/${m.subjectId}`,
      n: m.title,
      c: m.comment ?? '',
      d: m.markedAtRaw ?? '',
      k: m.medium,
      s: m.status,
    };
    // 又名单独一个字段：既要能搜，也要能在结果里显示出来——搜「重返沉默之丘」
    // 却只看到《重返寂静岭》的话，用户会以为搜错了。
    //
    // **没有就不要这个键，而不是设成 undefined。** JSON.stringify 会把
    // undefined 的键整个丢掉，于是「对象里有这个键」与「产出里有这个键」
    // 对不上——测试就是这么发现的。
    if (m.aliases && m.aliases.length) row.a = m.aliases;

    const who = indexedInfo(m.info);
    if (who) row.w = who;
    rows.push(row);
  }

  for (const b of p.broadcasts) {
    // 没有正文的广播不进索引——纯标记动作在标记那条里已经能搜到，
    // 收进来只会让结果里全是「想看 X」。
    if (!b.text) continue;
    rows.push({
      t: 'b',
      // 链到月页。**不猜锚点**：小标题的 id 是 SSG 生成的，各家规则不同，
      // 猜错了就是一个点了没反应的结果。结果里带时间，够用户在页面上找到它。
      u: `broadcast/${(b.postedAtRaw ?? '').slice(0, 7)}`,
      n: null,
      c: b.text,
      d: b.postedAtRaw ?? '',
    });
  }

  for (const r of p.longform) {
    rows.push({
      t: 'l',
      u: `${r.kind}/${r.id}`,
      n: r.title,
      c: r.body ?? '',
      d: r.publishedAtRaw ?? '',
      k: r.kind,
    });
  }

  // 时间倒序：同分时新的在前，而排序在生成时做一次就够，不必每次查询都做。
  rows.sort((a, b) => (a.d < b.d ? 1 : -1));

  const js = `/* 豆备搜索索引 —— 由 doubak-site-generator 生成，勿手改。\n`
    + `   ${rows.length} 条。用 <script> 而不是 fetch，因为 file:// 下 fetch 会被拦。 */\n`
    + `window.DOUBAK_SEARCH=${JSON.stringify(rows)};\n`;

  return { rows, js };
}

/**
 * `info` 里哪些进索引。
 *
 * ## 不是全都进
 *
 * 实测全量塞进去要多 908 KB——索引会翻倍。而里面大半是 ISBN、条形码、片长、
 * 唱片数这类**没人会拿去搜**的东西。
 *
 * ## 主演也不进，这一条是权衡不是遗漏
 *
 * 实测：
 *
 *     导演 / 编剧 / 作者 / 译者 / 表演者   + 96 KB
 *     再加上主演                        +435 KB   ← 四倍多
 *     再加上类型 / 流派                  +472 KB
 *
 * 豆瓣的主演动辄二十来个人，绝大多数是龙套。它们让索引涨四倍，换来的是
 * 「搜一个跑龙套的名字，翻出一部自己毫无印象的片子」。**想要的话把 '主演'
 * 加进下面这张表就行**——一行的事，代价上面写着。
 *
 * @param {Record<string, string[]>|null|undefined} info
 * @returns {string|undefined}
 */
function indexedInfo(info) {
  if (!info) return undefined;
  const KEYS = ['导演', '编剧', '作者', '译者', '表演者', '类型', '流派'];
  const parts = [];
  for (const k of KEYS) if (info[k]) parts.push(...info[k]);
  return parts.length ? parts.join(' / ') : undefined;
}
