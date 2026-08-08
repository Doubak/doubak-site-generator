/**
 * 投影与页面生成。
 *
 * 这一层的规则大多来自 CLAUDE.md 里几条硬性推论，违反了不会报错、只会让站点
 * 悄悄说出不实的话——所以每条都单独守着。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/generate.js';

import { project, groupMarks } from '../src/projection.js';
import {
  markPage, longformPage, markPath, longformPath, verb,
  broadcastMonthPage, broadcastMonthPath, monthOf, plainText,
} from '../src/markdown.js';

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

describe('「什么时候 → 说了什么」', () => {
  const withBc = (fields, over = {}) => bc({ target_id: '36838707', ...fields }, over);

  test('**广播保住了标记页上早就没有的那句话**', () => {
    // 这是整个项目要买的东西：标记页上只剩最新那条短评，改一次覆盖一次；
    // 而广播发布即冻结，所以它替我们记住了当初说的话，还带秒级时间戳。
    const p = project({
      marks: [mark({ revisions: [rev({ status: 'done', comment: '看过之后的话' }, 'x')] })],
      subjects: [subject()],
      broadcasts: [withBc({
        text: '想看时说的话', status: 'wish',
        posted_at: { raw: '2026-07-18 12:44:56', iso: '2026-07-18T12:44:56+08:00', precision: 'second' },
      })],
    });
    const [pm] = p.marks;
    assert.equal(pm.timeline.length, 2);
    const text = markPage(pm);
    assert.match(text, /## 说过什么/);
    assert.match(text, /想看时说的话/);
    assert.match(text, /2026-07-18 12:44:56/, '广播的秒级时间要留住');
  });

  test('**每一条都标出处** —— 两个来源的性质不一样', () => {
    // 广播是冻结的（那一刻就是这样），标记是可变的（我们某次抓取时看到的样子）。
    const p = project({
      marks: [mark({ revisions: [rev({ comment: '现在这句' }, 'x')] })],
      subjects: [subject()],
      broadcasts: [withBc({ text: '当初那句', action: '想看', status: 'wish' })],
    });
    const text = markPage(p.marks[0]);
    assert.match(text, /\*广播 · 想看\*/);
    assert.match(text, /\*标记 · /);

    // 没有动作的广播（纯发言）不该留一个悬着的「·」。
    const bare = project({
      marks: [mark({ revisions: [rev({ comment: '现在这句' }, 'x')] })],
      subjects: [subject()],
      broadcasts: [withBc({ text: '当初那句' })],
    });
    assert.match(markPage(bare.marks[0]), /\*广播\*/);
  });

  test('**不下「改过」的判断**', () => {
    // 实测 342 条与当前短评不同的发言里，305 条是状态推进（想看时说一句，
    // 看过之后又说一句），只有 15 条是同一状态下说了别的。呈现成「检测到编辑」
    // 的话 89% 都是冤枉的——那就是档案在说假话。
    const p = project({
      marks: [mark({ revisions: [rev({ comment: 'a' }, 'x')] })],
      subjects: [subject()],
      broadcasts: [withBc({ text: 'b' })],
    });
    const text = markPage(p.marks[0]);
    assert.ok(!/改过|编辑过|修改/.test(text), '不该断言用户改过');
  });

  test('**同一句话去重时，精度高的优先** —— 补零的时间不许挤掉真的', () => {
    // 标记只到天，canonical 会把它补成 T00:00:00；广播到秒。单纯按早晚挑的话，
    // 补出来的 00:00:00 永远排在同一天的广播前面，于是留下补零的、丢掉真的——
    // 而 partial_date.precision 存在的全部意义就是防这件事。实测踩到过。
    const p = project({
      marks: [mark({ revisions: [rev({
        status: 'wish', comment: '同一句',
        marked_at: { raw: '2026-07-18', iso: '2026-07-18T00:00:00+08:00', precision: 'day' },
      }, 'x')] })],
      subjects: [subject()],
      broadcasts: [withBc({
        text: '同一句', status: 'wish',
        posted_at: { raw: '2026-07-18 12:44:56', iso: '2026-07-18T12:44:56+08:00', precision: 'second' },
      })],
    });
    const [row] = p.marks[0].timeline.filter((r) => r.text === '同一句');
    assert.equal(row.source, 'broadcast', '该留广播那条（秒级），不是标记那条（补零的）');
    assert.equal(row.atRaw, '2026-07-18 12:44:56');
  });

  test('**同一句话去重时留最早的那条**', () => {
    // 实测「吹爆京阿尼」有两条：2018 的原帖，和 2025 用户转发自己那条旧广播。
    // 转发不是「又说了一遍」，是把旧的再推一次——这句话真正被说出口的时间是
    // 2018 年，那才是档案该记住的。
    const p = project({
      marks: [mark({ revisions: [rev({ comment: '别的' }, 'x')] })],
      subjects: [subject()],
      broadcasts: [
        withBc({ text: '同一句', posted_at: { raw: '2018-08-18 19:13:23', iso: '2018-08-18T19:13:23+08:00', precision: 'second' } }, { upstream_id: '1' }),
        withBc({ text: '同一句', posted_at: { raw: '2025-10-26 13:18:31', iso: '2025-10-26T13:18:31+08:00', precision: 'second' } }, { upstream_id: '2' }),
      ],
    });
    const said = p.marks[0].timeline.filter((r) => r.text === '同一句');
    assert.equal(said.length, 1, '同一句话只该列一次');
    assert.equal(said[0].atRaw, '2018-08-18 19:13:23', '留下的应当是最早那条');
  });

  test('**作品 id 撞车时不接** —— 接错了是档案在说假话', () => {
    const two = [
      mark({ medium: 'movie', subject: { id: '999', url: null, upstream_deleted: false } }),
      mark({ medium: 'game', subject: { id: '999', url: null, upstream_deleted: false } }),
    ];
    const p = project({
      marks: two, subjects: [subject({ id: '999' })],
      broadcasts: [withBc({ target_id: '999', text: '这句话属于谁？' })],
    });
    for (const pm of p.marks) {
      assert.ok(!pm.timeline.some((r) => r.source === 'broadcast'), 'id 撞车时不该接广播');
    }
  });

  test('只有当前那一条短评时，不生成这一段', () => {
    // 正文里已经有了，再列一遍是噪音。
    const p = project({ marks: [mark({ revisions: [rev({ comment: '只有这句' }, 'x')] })], subjects: [subject()] });
    assert.ok(!/## 说过什么/.test(markPage(p.marks[0])));
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

/** 造一条 canonical 广播。 */
const bc = (fields, over = {}) => ({
  canonical_version: 'canonical/1.0',
  identity_layer: 'upstream_id',
  upstream_id: '3669403283',
  url: 'https://www.douban.com/people/82160871/status/3669403283/',
  revisions: [{
    parser_version: 'p/1',
    first_observed_at: '2026-08-01T00:00:00+08:00',
    last_observed_at: '2026-08-01T00:00:00+08:00',
    fields: {
      posted_at: { raw: '2021-11-28 20:25:21', iso: '2021-11-28T20:25:21+08:00', precision: 'second' },
      text: null, action: null, status: null, target_type: null, target_id: null, images: [],
      ...fields,
    },
    digests: {}, observations: [],
  }],
  ...over,
});

describe('广播', () => {
  test('按月归档，月内倒序', () => {
    // 头插列表，新的在上。这与抓取方向、与「上面的都抓到了」那个不变量一致。
    const list = [
      { postedAtRaw: '2021-11-02 10:00:00', postedAt: '2021-11-02T10:00:00+08:00', text: '早', images: [], action: null, target: null },
      { postedAtRaw: '2021-11-28 20:25:21', postedAt: '2021-11-28T20:25:21+08:00', text: '晚', images: [], action: null, target: null },
    ];
    const text = broadcastMonthPage('2021-11', list);
    assert.ok(text.indexOf('晚') < text.indexOf('早'), '月内应当倒序');
    assert.match(text, /^title: "2021年11月"$/m);
    assert.equal(broadcastMonthPath('2021-11'), 'broadcast/2021-11.md');
  });

  test('**按本地时间切月，不按 UTC**', () => {
    // canonical 的时间戳带 +08:00。按 UTC 切的话，每月头八小时的广播会掉到
    // 上一个月去——一个不报错、只让归档悄悄错位的 bug。
    assert.equal(monthOf({ postedAtRaw: '2021-11-01 03:00:00', postedAt: '2021-11-01T03:00:00+08:00' }), '2021-11');
  });

  test('**带正文的条数单独给** —— 总数里大部分是纯标记动作', () => {
    // 实测 3394 条里只有 804 条带正文。只报总数会让「我写了多少东西」看起来
    // 比实际多四倍。
    const list = [
      { postedAtRaw: '2021-11-02 10:00:00', text: '写了字', images: [], action: null, target: null },
      { postedAtRaw: '2021-11-03 10:00:00', text: null, images: [], action: '想看', target: null },
    ];
    const text = broadcastMonthPage('2021-11', list);
    assert.match(text, /^douban_count: 2$/m);
    assert.match(text, /^douban_with_text: 1$/m);
  });

  test('接得回本地作品页就接，接不回来只留文字 —— **不回退到豆瓣 URL**', () => {
    // 回退到豆瓣的话，一份号称离线可看的档案会为了一个链接去联网。
    const linked = broadcastMonthPage('2021-11', [{
      postedAtRaw: '2021-11-02 10:00:00', text: null, images: [],
      action: '想看', target: { medium: 'movie', subjectId: '37450627', title: '痴迷' },
    }]);
    // **链接指向那个 .md 文件，不是某种 URL 方案。** 硬编码 `/movie/123/` 的话，
    // SSG 一改固定链接方案（Hugo 的 uglyURLs 就够了）这些链接就全断——
    // 而 file:// 下浏览器会把它们显示成目录列表。
    assert.match(linked, /想看 \[痴迷\]\(\.\.\/movie\/37450627\.md\)/);

    // **url 必须给上**：不给的话回退根本无从发生，这条测试就只是在测「undefined
    // 不会被拼进字符串」，而那不是要守的性质。
    const bare = broadcastMonthPage('2021-11', [{
      postedAtRaw: '2021-11-02 10:00:00', text: null, images: [], action: '想看', target: null,
      url: 'https://www.douban.com/people/82160871/status/3669403283/',
    }]);
    assert.match(bare, /^想看$/m);
    assert.ok(!/douban\.com/.test(bare));
  });

  test('**作品 id 撞车时一律不接** —— 接错了比不接严重得多', () => {
    // 广播上只有 data-object-id，没有媒介。撞了还硬接的话，页面上会出现一条
    // 指向另一部作品的链接：不接只是少个链接，接错了是档案在说假话，而且看不出来。
    const marks = [
      { canonical_version: 'c', identity_layer: 'upstream_id', upstream_id: '1',
        account: {}, medium: 'movie', subject: { id: '999', url: null, upstream_deleted: false },
        revisions: [rev({}, 'x')] },
      { canonical_version: 'c', identity_layer: 'upstream_id', upstream_id: '2',
        account: {}, medium: 'game', subject: { id: '999', url: null, upstream_deleted: false },
        revisions: [rev({}, 'x')] },
    ];
    const p = project({ marks, subjects: [], broadcasts: [bc({ action: '想看', target_id: '999' })] });
    assert.equal(p.broadcasts[0].target, null, 'id 撞车时不该接');
  });

  test('**被截断的广播必须在页面上说出来**', () => {
    // 显示半截正文而不声明，站点就在替档案说假话。
    const p = project({ broadcasts: [bc({
      text: '开头一段', text_truncated: true,
      full_text_url: 'https://www.douban.com/note/872015292/',
    })] });
    assert.equal(p.broadcasts[0].textTruncated, true);
    const text = broadcastMonthPage('2021-11', p.broadcasts);
    assert.match(text, /豆瓣在这里截断了/);
    // 全文接回**本地**那一页，不是豆瓣。
    assert.match(text, /\.\.\/note\/872015292\.md/);
    assert.ok(!/douban\.com/.test(text), '不该回退到豆瓣的 URL');
  });

  test('接不回本地长文时只说被截断，仍然不给豆瓣链接', () => {
    const p = project({ broadcasts: [bc({
      text: '开头', text_truncated: true, full_text_url: 'https://www.douban.com/something/else/',
    })] });
    assert.equal(p.broadcasts[0].fullText, null);
    const text = broadcastMonthPage('2021-11', p.broadcasts);
    assert.match(text, /全文不在档案里/);
    assert.ok(!/douban\.com/.test(text));
  });

  test('没被截断的广播不该冒出这句话', () => {
    const p = project({ broadcasts: [bc({ text: '完整的一条' })] });
    assert.ok(!/截断/.test(broadcastMonthPage('2021-11', p.broadcasts)));
  });

  test('附图换成本地路径', () => {
    const p = project({ broadcasts: [bc({ images: ['https://img1.doubanio.com/x/p1.jpg'] })] });
    assert.deepEqual(p.broadcasts[0].images, ['https://img1.doubanio.com/x/p1.jpg']);
    const text = broadcastMonthPage('2021-11', p.broadcasts, {
      images: { 'https://img1.doubanio.com/x/p1.jpg': '/uploads/p1.jpg' },
    });
    assert.match(text, /!\[\]\(\/uploads\/p1\.jpg\)/);
  });
});

describe('Hugo 骨架', () => {
  const THEME = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'hugo');

  test('骨架本身是完整的', () => {
    // 少一个 baseof.html，Hugo 不会报错，它会**渲染出没有 <html> 的碎片**——
    // 页面能打开、内容也在，只是没有样式没有导航。那种失败最难发现。
    for (const f of ['hugo.toml', 'layouts/index.html',
      'layouts/_default/baseof.html', 'layouts/_default/list.html',
      'layouts/_default/single.html']) {
      assert.ok(existsSync(join(THEME, f)), `骨架缺 ${f}`);
    }
  });

  test('**骨架里不许有 content/**', () => {
    // 有的话会盖掉刚生成的那 3098 个页面，而产出目录看起来完全正常。
    assert.ok(!existsSync(join(THEME, 'content')), '骨架不该带 content/');
  });

  test('拷进产出目录，且不碰 content/', () => {
    const out = mkdtempSync(join(tmpdir(), 'doubak-theme-'));
    const canonical = { marks: [], subjects: [], longform: [], broadcasts: [] };
    const r = generate({ canonical, outDir: out, themeDir: THEME });
    assert.ok(existsSync(join(out, 'hugo.toml')));
    assert.ok(existsSync(join(out, 'layouts/_default/baseof.html')));
    assert.ok(existsSync(join(out, 'content/_index.md')), '首页应当还在');
    assert.equal(r.theme, THEME);
  });

  test('**不给 themeDir，产出里不许有任何 Hugo 专属的东西**', () => {
    // Markdown 才是这个工具的产物，HTML 只是它的一个消费者。有人要把 content/
    // 塞进 Astro / Eleventy / Jekyll，那时候多出一个 hugo.toml 不只是碍事——
    // Hugo 之外的 SSG 见到它多半会当成待渲染的内容文件。
    const out = mkdtempSync(join(tmpdir(), 'doubak-notheme-'));
    const r = generate({
      canonical: {
        marks: [mark()], subjects: [subject()], longform: [], broadcasts: [],
      },
      outDir: out,
    });
    assert.equal(r.theme, null);
    assert.deepEqual(readdirSync(out).sort(), ['content']);
    const all = readdirSync(out, { recursive: true }).map(String);
    for (const f of all) {
      assert.ok(!/hugo|layouts|\.html$/i.test(f), `产出里混进了 Hugo 专属的 ${f}`);
    }
  });

  test('front matter 里除了三个通用键，全部带 douban_ 前缀', () => {
    // 前缀是为了不撞上主题自己的约定。撞上了不会报错——主题会拿我们的值
    // 去做它自己的事，页面看起来正常而内容是错的。
    const [pm] = project({ marks: [mark()], subjects: [subject()] }).marks;
    const keys = [...markPage(pm).matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    const strays = keys.filter((k) => !k.startsWith('douban_') && !['title', 'date', 'tags'].includes(k));
    assert.deepEqual(strays, [], `这些键既不通用也没前缀：${strays.join(' ')}`);
  });

  test('**模板里引用的 front matter 键，生成器真的会写**', () => {
    // 这两边是靠字符串对上的，拼错一个字不会报错——Hugo 对不存在的 .Params.x
    // 返回空值，页面照样渲染，只是那一块永远是空的。
    const used = new Set();
    for (const f of readdirSync(join(THEME, 'layouts'), { recursive: true })) {
      const p = join(THEME, 'layouts', String(f));
      if (!String(f).endsWith('.html')) continue;
      for (const m of readFileSync(p, 'utf-8').matchAll(/\.Params\.(douban_\w+)/g)) used.add(m[1]);
    }
    assert.ok(used.size > 5, '没从模板里扫到几个键，扫描本身可能坏了');

    const [pm] = project({ marks: [mark()], subjects: [subject()] }).marks;
    const emitted = new Set([
      ...markPage(pm).matchAll(/^(douban_\w+):/gm),
      ...broadcastMonthPage('2021-11', [{
        postedAtRaw: '2021-11-02 10:00:00', text: 'x', images: [], action: null, target: null,
      }]).matchAll(/^(douban_\w+):/gm),
      // 字段要给全（哪怕是 null）。`undefined` 是**故意**不写出来的，
      // 所以一个偷懒的 fixture 会让这条测试去告生成器的状。
      ...longformPage({ kind: 'note', id: '1', url: null, title: 't', body: 'b',
        publishedAt: null, publishedAtRaw: null, location: null, rating: null,
        subjectUrl: null, revisionCount: 1, lastSeenAt: 'x' }).matchAll(/^(douban_\w+):/gm),
    ].map((m) => m[1]));

    const missing = [...used].filter((k) => !emitted.has(k));
    assert.deepEqual(missing, [], `模板引用了生成器不写的键：${missing.join(' ')}`);
  });
});

describe('用户写的字必须原样呈现', () => {
  // 这一组是拿真的 Hugo 量出来的，不是照 CommonMark 规范推的。
  // 实测那份档案 2831 段自撰文本里有 62 段会被 Markdown 悄悄改写。

  test('**颜文字不许变成斜体** —— 实测 24 处', () => {
    // `_(:з」∠)_` 被渲染成 <em>(:з」∠)</em>，下划线连同语气一起没了。
    // 这是中文互联网最常见的那个颜文字，而它恰好长得像 Markdown 的强调。
    assert.equal(plainText('_(:з」∠)_'), '\\_(:з」∠)\\_');
    assert.equal(plainText('(*/ ω \\*)'), '(\\*/ ω \\\\\\*)');
  });

  test('**尖括号里的字不许整个消失**', () => {
    // `From <May December>` 在页面上只剩 `From ` —— goldmark 当 <May December>
    // 是裸 HTML 直接丢掉。这一类最严重：页面上什么都不剩，看不出这儿本来有字。
    assert.equal(plainText('From <May December>'), 'From &lt;May December&gt;');
  });

  test('反斜杠先转，否则会把后加的反斜杠又转一遍', () => {
    assert.equal(plainText('C:\\path'), 'C:\\\\path');
  });

  test('块首记号只在行首转义 —— `a-b` 不该被动', () => {
    assert.equal(plainText('a-b 正常'), 'a-b 正常');
    assert.equal(plainText('- 列表'), '\\- 列表');
    assert.equal(plainText('第一行\n- 第二行'), '第一行\n\\- 第二行');
  });

  test('**有序列表转义的是点，不是数字**', () => {
    // CommonMark 不允许转义数字：`\\1.` 会原样渲染成一个反斜杠加 1。
    // 实测确认过——这是唯一一条推错了、被 Hugo 纠正过来的规则。
    assert.equal(plainText('1. one'), '1\\. one');
  });

  test('三条正文路径都转义了', () => {
    const [pm] = project({
      marks: [mark({ revisions: [rev({ comment: '_(:з」∠)_' }, 'x')] })], subjects: [subject()],
    }).marks;
    assert.match(markPage(pm), /\\_\(:з」∠\)\\_/);

    assert.match(broadcastMonthPage('2021-11', [{
      postedAtRaw: '2021-11-02 10:00:00', text: 'From <May December>',
      images: [], action: null, target: null,
    }]), /From &lt;May December&gt;/);
  });

  test('**长文正文里解析器插的图片标记不许被转义**', () => {
    // 正文混着两种东西：用户写的字，和解析器插进去的 ![](url)。
    // 一起转义的话，图就变成一行字面文本了。
    const [p] = project({ longform: [{
      kind: 'note', upstream_id: '1', url: null,
      revisions: [{
        parser_version: 'p/1', first_observed_at: 'x', last_observed_at: 'x',
        fields: {
          title: 't', published_at: null,
          body: '_颜文字_\n\n![](https://img1.doubanio.com/x/a.jpg)\n\n后面 <tag> 的字',
        },
        digests: {}, observations: [],
      }],
    }] }).longform;
    const text = longformPage(p, { images: { 'https://img1.doubanio.com/x/a.jpg': '/uploads/a.jpg' } });
    assert.match(text, /!\[\]\(\/uploads\/a\.jpg\)/, '图片标记被转义了');
    assert.match(text, /\\_颜文字\\_/);
    assert.match(text, /&lt;tag&gt;/);
  });
});
