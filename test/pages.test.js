/**
 * 投影与页面生成。
 *
 * 这一层的规则大多来自 CLAUDE.md 里几条硬性推论，违反了不会报错、只会让站点
 * 悄悄说出不实的话——所以每条都单独守着。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { project, groupMarks } from '../src/projection.js';
import { markPage, longformPage, markPath, longformPath, verb } from '../src/markdown.js';

/** 造一条 canonical 标记。 */
const mark = (over = {}) => ({
  canonical_version: 'canonical/1.0',
  identity_layer: 'upstream_id',
  upstream_id: '4891953008',
  account: { user_id: '82160871', username: 'x' },
  medium: 'movie',
  subject: { id: '36838707', url: 'https://movie.douban.com/subject/36838707/', upstream_deleted: false },
  revisions: [rev({ status: 'wish', comment: '想看的时候写的' }, '2026-08-01T00:00:00+08:00')],
  ...over,
});

const rev = (fields, at) => ({
  parser_version: 'p/1',
  first_observed_at: at,
  last_observed_at: at,
  fields: {
    status: 'done', marked_at: { raw: '2026-08-01', iso: '2026-08-01T00:00:00+08:00', precision: 'day' },
    rating: null, comment: null, tags: null, ...fields,
  },
  digests: {},
  observations: [{ bundle_id: 'b', capture_ids: ['b#1'], observed_at: at, absence_authority: 'none' }],
});

const subject = (over = {}) => ({
  canonical_version: 'canonical/1.0',
  medium: 'movie',
  id: '36838707',
  upstream_deleted: false,
  revisions: [{
    parser_version: 'p/1',
    first_observed_at: '2026-08-01T00:00:00+08:00',
    last_observed_at: '2026-08-01T00:00:00+08:00',
    fields: { title: '某部电影', cover_url: 'https://img1.doubanio.com/x.jpg', raw_meta: '2024 / 导演' },
    digests: {},
    observations: [],
  }],
  ...over,
});

describe('投影取「我们最后一次看到的样子」', () => {
  test('多条修订取最后一条', () => {
    const m = mark({
      revisions: [
        rev({ status: 'wish', comment: '旧的' }, '2026-08-01T00:00:00+08:00'),
        rev({ status: 'done', comment: '新的', rating: 4 }, '2026-08-04T00:00:00+08:00'),
      ],
    });
    const [p] = project({ marks: [m], subjects: [subject()] }).marks;
    assert.equal(p.status, 'done');
    assert.equal(p.comment, '新的');
    assert.equal(p.rating, 4);
    // **留一条通往 canonical 的线索。** 投影是有损的，把历史整个抹掉会让它
    // 显得像是全部真相。
    assert.equal(p.revisionCount, 2);
  });

  test('**上游被删时作品名保持 null，不拿占位符顶替**', () => {
    // 页面上那句「未知电影」是豆瓣的占位符。填进去它会一路传到页面标题、
    // 外部检索、导出文件里。
    const m = mark({ subject: { id: '1', url: null, upstream_deleted: true } });
    const s = subject({ id: '1', upstream_deleted: true, revisions: [{
      parser_version: 'p/1', first_observed_at: 'x', last_observed_at: 'x',
      fields: { title: null, cover_url: null, raw_meta: null }, digests: {}, observations: [],
    }] });
    const [p] = project({ marks: [m], subjects: [s] }).marks;
    assert.equal(p.title, null);
    assert.equal(p.upstreamDeleted, true);
  });
});

describe('页面', () => {
  test('动词跟着媒介走 —— 「看过一本书」是错的', () => {
    assert.equal(verb('book', 'done'), '读过');
    assert.equal(verb('music', 'done'), '听过');
    assert.equal(verb('game', 'doing'), '在玩');
  });

  test('短评进正文，没有短评就是空正文', () => {
    // 不编一句「暂无短评」：那会让「没写」和「写了但抓不到」在页面上长得一样。
    const [p] = project({ marks: [mark()], subjects: [subject()] }).marks;
    assert.match(markPage(p), /想看的时候写的/);

    const [q] = project({
      marks: [mark({ revisions: [rev({ comment: null }, 'x')] })], subjects: [subject()],
    }).marks;
    const text = markPage(q);
    assert.ok(text.trimEnd().endsWith('---'), '不该有正文，也不该编一句占位的话');
  });

  test('**元信息原样带过去，不在这一层拆**', () => {
    // 实测电影 2090 条里出现过 43 种段数，按位置拆多数行都错；按内容猜属于
    // enricher（它的产出带 source 与置信度、可以重跑）。
    const [p] = project({ marks: [mark()], subjects: [subject()] }).marks;
    assert.match(markPage(p), /douban_meta: "2024 \/ 导演"/);
  });

  test('导出到本地的封面优先于 doubanio 的 URL', () => {
    // 不导出的话，这份备份要联网、而且要豆瓣还在才看得见图。
    const [p] = project({ marks: [mark()], subjects: [subject()] }).marks;
    assert.match(markPage(p, { coverPath: '/covers/x.jpg' }), /douban_cover: "\/covers\/x\.jpg"/);
    assert.match(markPage(p), /douban_cover: "https:\/\/img1\.doubanio\.com/);
  });

  test('**豆瓣的「暂无封面」占位图当成没有封面**', () => {
    // 与上面那条「作品名保持 null」是同一条规则：占位符不是内容。原样带过去的话，
    // 页面上会留一个指向 doubanio 的 URL——让一份号称离线可看的备份，
    // 为了一张本来就不存在的图去联网。
    const s = subject({ revisions: [{
      parser_version: 'p/1', first_observed_at: 'x', last_observed_at: 'x',
      fields: {
        title: null, raw_meta: null,
        cover_url: 'https://img1.doubanio.com/cuphead/ilmen-static/pics/subject/game_normal.png',
      },
      digests: {}, observations: [],
    }] });
    const [p] = project({ marks: [mark()], subjects: [s] }).marks;
    assert.equal(p.coverUrl, null);
    assert.match(markPage(p), /^douban_cover: null$/m);
  });

  test('文件名用 id 不用标题', () => {
    // 标题会变、可能是 null、还可能撞名。id 稳定，固定链接才不会在重新生成之后变。
    const [p] = project({ marks: [mark()], subjects: [subject()] }).marks;
    assert.equal(markPath(p), 'movie/36838707.md');
  });

  test('长文：正文里的图换成本地路径，没导出的保持原样', () => {
    const lf = {
      kind: 'note', upstream_id: '1', url: null,
      revisions: [{
        parser_version: 'p/1', first_observed_at: 'x', last_observed_at: 'x',
        fields: {
          title: '标题', body: '看这张 https://img1.doubanio.com/a.jpg 还有 https://img2.doubanio.com/b.jpg',
          published_at: null,
        },
        digests: {}, observations: [],
      }],
    };
    const [p] = project({ longform: [lf] }).longform;
    const text = longformPage(p, { images: { 'https://img1.doubanio.com/a.jpg': '/uploads/a.jpg' } });
    assert.match(text, /\/uploads\/a\.jpg/);
    // 留一个指向 doubanio 的 URL，总比悄悄删掉一张图好——前者至少说明「这儿本来有图」。
    assert.match(text, /img2\.doubanio\.com\/b\.jpg/);
    assert.equal(longformPath(p), 'note/1.md');
  });
});

describe('分组', () => {
  test('按媒介与状态分，组内按标记时间倒序', () => {
    const marks = [
      { medium: 'movie', status: 'done', markedAt: '2026-01-01' },
      { medium: 'movie', status: 'done', markedAt: '2026-08-01' },
      { medium: 'book', status: 'wish', markedAt: null },
    ];
    const g = groupMarks(marks);
    assert.deepEqual(g.get('movie').get('done').map((m) => m.markedAt), ['2026-08-01', '2026-01-01']);
    assert.equal(g.get('book').get('wish').length, 1);
  });

  test('**没有时间的排最后，不当成 1970 年排最前**', () => {
    const g = groupMarks([
      { medium: 'movie', status: 'done', markedAt: null },
      { medium: 'movie', status: 'done', markedAt: '2020-01-01' },
    ]);
    assert.deepEqual(g.get('movie').get('done').map((m) => m.markedAt), ['2020-01-01', null]);
  });
});
