/**
 * 豆瓣上不公开的那些日记，按**是谁让它不公开的**分开。
 *
 * ## 两个方向相反，所以调用方不该有默认动作
 *
 * | | 发出去意味着 | 不发出去意味着 |
 * |---|---|---|
 * | 作者自己设的私密 | **把他藏起来的东西公开了**，撤不回来 | 尊重他的决定 |
 * | 豆瓣锁的 | 正是这份存档存在的理由 | **这份存档替豆瓣把它二次消音** |
 *
 * 后一种更隐蔽：一条被静默藏起来的记录不留任何痕迹给人发现。所以这个函数只**点名**，
 * 不筛选——`bin/deploy.js` 把三栏原样印出来，让按下去的人自己看见。这是那条
 * 「一句正确的话，出现在做决定的人读不到的地方」的直接应用：铺进仓库是不可逆的，
 * 而只有部署预演在它前面。
 *
 * 单独成一个文件而不是留在 `bin/deploy.js` 里，是因为那个脚本一 import 就跑起来
 * （顶层副作用），于是只能靠读源码来测——而这里要守的是**行为**，不是一个常量。
 */

/** `--drop-notes` 认得的三栏。 */
export const DROPPABLE = ['author', 'platform', 'unsure'];

/**
 * @param {object[]} longform canonical 的 longform 记录
 * @returns {{author: object[], platform: object[], unsure: object[]}}
 */
export function restrictedNotes(longform) {
  /** @type {{author: object[], platform: object[], unsure: object[]}} */
  const buckets = { author: [], platform: [], unsure: [] };
  for (const rec of longform ?? []) {
    // 评论恒为 null（实测：豆瓣没给评论这个功能，页面上连隐私容器都没有），
    // 不进任何一栏——否则这份名单上会永远挂着两条谁也处理不了的东西，
    // 而**一份永远有条目的名单是没人看的名单**。
    if (rec.kind !== 'note') continue;
    const f = rec.revisions?.[rec.revisions.length - 1]?.fields ?? {};
    if (f.visibility === 'public') continue;
    // `unknown` 与 `null` 都归进「说不准」：页面上认不出来（豆瓣改版），或者这份
    // canonical 是加这个字段之前生成的。两者都**不当作公开**——把「认不出来」并进
    // 「公开」是这条链路上最坏的方向。
    const where = f.visibility === 'private'
      ? (f.restricted_by === 'platform' ? 'platform' : 'author')
      : 'unsure';
    buckets[where].push({
      title: f.title ?? '(无标题)',
      id: rec.upstream_id,
      notice: f.restriction_notice ?? null,
    });
  }
  return buckets;
}
