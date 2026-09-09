/**
 * 部署预演里那份「豆瓣上不公开的日记」名单。
 *
 * 这一层守的是一件不可逆的事：`bin/deploy.js` 把私人档案铺成公开网页。而
 * 「仅自己可见」有两个成因，**方向相反**——作者自己藏的，发出去就撤不回来；
 * 豆瓣锁掉的，不发出去就是这份存档替豆瓣把它二次消音，而且不留痕迹给人发现。
 *
 * 所以这里不筛选，只点名，而**点名点错了比不点名更糟**：把豆瓣锁的说成作者藏的，
 * 等于告诉用户「这是你自己藏的」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  privateContent, withoutPrivate, privacyKnown, noteBucket, DROPPABLE, PRIVATE_BY_DEFAULT,
} from '../src/private.js';

const rec = (kind, id, fields) => ({ kind, upstream_id: id, revisions: [{ fields }] });
/** 旧签名的等价物：只看日记那三栏。 */
const notesOf = (longform) => privateContent({ longform }).notes;

describe('豆瓣上不公开的日记', () => {
  test('三栏各归各的', () => {
    const b = notesOf([
      rec('note', '1', { title: '公开的', visibility: 'public' }),
      rec('note', '2', { title: '作者藏的', visibility: 'private', restricted_by: 'author' }),
      rec('note', '3', {
        title: '豆瓣锁的', visibility: 'private', restricted_by: 'platform',
        restriction_notice: '含有违规或引发不良讨论的内容',
      }),
      rec('note', '4', { title: '认不出来', visibility: 'unknown' }),
    ]);
    assert.deepEqual(b.author.map((x) => x.id), ['2']);
    assert.deepEqual(b.platform.map((x) => x.id), ['3']);
    assert.deepEqual(b.unsure.map((x) => x.id), ['4']);
    // 判词要带出来：预演里要把豆瓣的原话印在那一行下面，看的人才知道这是哪一种。
    assert.match(b.platform[0].notice, /含有违规/);
  });

  test('**公开的一篇都不许进名单**', () => {
    // 进了的话这份名单每次部署都有几百条，而一份永远有条目的名单是没人看的名单。
    const b = notesOf([rec('note', '1', { visibility: 'public' })]);
    assert.equal(b.author.length + b.platform.length + b.unsure.length, 0);
  });

  test('**没有这个字段的老 canonical 算「说不准」，不算公开**', () => {
    // 加这个字段之前生成的 canonical 里，visibility 根本不存在。当成公开的话，
    // 用旧档案部署一次就把该拦的全放出去了——而这正是这条链路上最坏的方向。
    const b = notesOf([rec('note', '1', { title: '老档案' })]);
    assert.deepEqual(b.unsure.map((x) => x.id), ['1']);
  });

  test('**评论不进名单** —— 它恒为 null，因为豆瓣没给评论这个功能', () => {
    // 实测 2 篇评论页上「私密」「仅自己」「可见」一个字都没有，连容器都不存在。
    // 让它们进「说不准」的话，每次部署都会挂着两条谁也处理不了的东西。
    const b = notesOf([rec('review', '1', { title: '一篇评论' })]);
    assert.equal(b.unsure.length, 0);
  });

  test('**私密但认不出是谁设的 → author，不是 platform**', () => {
    // platform 要正面证据（豆瓣那条通告）。反过来默认的话，一篇作者自己藏的日记
    // 会被说成「豆瓣锁的」——那是在替用户编造一件豆瓣没做过的事。
    const b = notesOf([rec('note', '1', { visibility: 'private' })]);
    assert.deepEqual(b.author.map((x) => x.id), ['1']);
    assert.equal(b.platform.length, 0);
  });

  test('取最后一条修订 —— 一篇日记可能是先公开、后来才被锁的', () => {
    const r = rec('note', '1', { visibility: 'public' });
    r.revisions.push({ fields: { title: '后来被锁了', visibility: 'private', restricted_by: 'platform' } });
    assert.deepEqual(notesOf([r]).platform.map((x) => x.id), ['1']);
  });

  test('DROPPABLE 与实际的三栏一一对应', () => {
    // 少一栏的话 `--drop-notes=<那一栏>` 会被当成拼写错误挡下来，而用户看到的
    // 名单里明明有它。
    assert.deepEqual([...DROPPABLE].sort(), Object.keys(notesOf([])).sort());
  });
});

// ── 广播与豆列：内容会从旁边那条路漏出去 ────────────────────────────────

const bc = (id, fields) => ({ upstream_id: id, revisions: [{ fields }] });

describe('私密广播与私密豆列', () => {
  const canonical = () => ({
    longform: [rec('note', 'n1', { title: '私密日记', visibility: 'private', restricted_by: 'author' })],
    broadcasts: [
      bc('b1', { text: '就反正是一篇私密日记', visibility: 'private' }),
      bc('b2', { text: '一条公开广播', visibility: 'public' }),
    ],
    doulists: [
      { upstream_id: 'd1', revisions: [{ fields: { title: 'SELECTS', visibility: 'private' } }] },
      { upstream_id: 'd2', revisions: [{ fields: { title: '我的收藏', visibility: 'public' } }] },
    ],
  });

  test('**默认三种都不发** —— 这次的起因是广播那条路', () => {
    // 豆瓣发一篇私密日记时会同步一条广播，正文一字不差。**它绕过日记那一侧的
    // 所有开关**——实测那篇日记的全文因此出现在样张站的首页上。
    const out = withoutPrivate(canonical());
    assert.deepEqual(out.longform.map((r) => r.upstream_id), []);
    assert.deepEqual(out.broadcasts.map((r) => r.upstream_id), ['b2']);
    assert.deepEqual(out.doulists.map((r) => r.upstream_id), ['d2']);
  });

  test('--include-private 三种都发', () => {
    const out = withoutPrivate(canonical(), { includePrivate: true });
    assert.equal(out.longform.length, 1);
    assert.equal(out.broadcasts.length, 2);
    assert.equal(out.doulists.length, 2);
  });

  test('**豆瓣锁掉的那一篇默认照发** —— 09-07 那条决定没变', () => {
    // 它之所以不公开，恰恰因为它曾经是公开的。跟着豆瓣一起收起来，这份存档就白存了。
    const c = { longform: [rec('note', 'p1', { visibility: 'private', restricted_by: 'platform' })] };
    assert.equal(withoutPrivate(c).longform.length, 1);
    // 但显式要求拿掉时跟着走——显式压过默认。
    assert.equal(withoutPrivate(c, { dropNotes: ['platform'] }).longform.length, 0);
    // 反过来也一样：--include-private 不许推翻用户刚说过的话。
    assert.equal(
      withoutPrivate(c, { includePrivate: true, dropNotes: ['platform'] }).longform.length, 0,
      '显式 --drop-notes 必须压过 --include-private',
    );
  });

  test('**老 canonical 里一条都不筛** —— 否则整条时间线被清空', () => {
    // 0.13.0 之前每一条广播都没有这个字段。照「null 当私密」办，就是把实测 3429 条
    // 广播全部从站点上抹掉——**一个破坏性大到没人敢用的默认值，等于没有默认值**。
    // 判据是整个数据集：一条非 null 都没有，就说明这份 canonical 根本没这个信息。
    const old = {
      longform: [],
      broadcasts: [bc('b1', { text: '甲' }), bc('b2', { text: '乙' })],
      doulists: [],
    };
    assert.equal(privacyKnown(old.broadcasts), false);
    assert.equal(withoutPrivate(old).broadcasts.length, 2, '老 canonical 不许被清空');
    // 而只要有一条读出来了，剩下的 null 就是「这一条认不出来」，按私密处理。
    const mixed = { longform: [], broadcasts: [bc('b1', { text: '甲' }), bc('b2', { text: '乙', visibility: 'public' })] };
    assert.equal(privacyKnown(mixed.broadcasts), true);
    assert.deepEqual(withoutPrivate(mixed).broadcasts.map((r) => r.upstream_id), ['b2']);
  });

  test('**点名时也要分清「没有私密的」和「没有这个信息」**', () => {
    // 老 canonical 上点名是假的：每一条都会被列出来。那种情况下该报的是
    // 「这份 canonical 没有这个信息」，而不是「这 3429 条是私密的」。
    const old = { longform: [], broadcasts: [bc('b1', { text: '甲' })], doulists: [] };
    const p = privateContent(old);
    assert.deepEqual(p.broadcasts, [], '不知道的时候不许点名');
    assert.deepEqual(p.unknownPrivacy, ['broadcasts']);
    // 知道的时候，点名要准。
    const p2 = privateContent(canonical());
    assert.deepEqual(p2.broadcasts.map((x) => x.id), ['b1']);
    assert.deepEqual(p2.doulists.map((x) => x.title), ['SELECTS']);
    assert.deepEqual(p2.unknownPrivacy, []);
  });
});

test('**发出去的私密广播，页面上要看得出来**', async () => {
  // 走到这一步说明加了 `--include-private`。一个看起来和别人一样的公开条目，
  // 实际来自只有自己看得见的时间线——不说，用户就不知道自己刚发出去了什么。
  const { broadcastBlock } = await import('../src/markdown.js');
  const one = (visibility) => broadcastBlock({
    id: 'b1', postedAtRaw: '2026-09-07 16:56:22', text: '就反正是一篇私密日记',
    images: [], actionParts: null, visibility,
  });
  assert.match(one('private'), /🔒 \*\*这条广播在豆瓣上只有你自己看得见。\*\*/);
  // 公开的不许多出这一行。**null 也不标**：0.13.0 之前的 canonical 里每一条都是
  // null，逐条挂锁就是每条广播都加一枚图标——一份永远有标记的页面等于没有标记。
  assert.doesNotMatch(one('public'), /🔒/);
  assert.doesNotMatch(one(null), /🔒/);
  assert.doesNotMatch(one(undefined), /🔒/);
});
