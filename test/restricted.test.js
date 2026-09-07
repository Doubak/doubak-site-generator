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

import { restrictedNotes, DROPPABLE } from '../src/restricted.js';

const rec = (kind, id, fields) => ({ kind, upstream_id: id, revisions: [{ fields }] });

describe('豆瓣上不公开的日记', () => {
  test('三栏各归各的', () => {
    const b = restrictedNotes([
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
    const b = restrictedNotes([rec('note', '1', { visibility: 'public' })]);
    assert.equal(b.author.length + b.platform.length + b.unsure.length, 0);
  });

  test('**没有这个字段的老 canonical 算「说不准」，不算公开**', () => {
    // 加这个字段之前生成的 canonical 里，visibility 根本不存在。当成公开的话，
    // 用旧档案部署一次就把该拦的全放出去了——而这正是这条链路上最坏的方向。
    const b = restrictedNotes([rec('note', '1', { title: '老档案' })]);
    assert.deepEqual(b.unsure.map((x) => x.id), ['1']);
  });

  test('**评论不进名单** —— 它恒为 null，因为豆瓣没给评论这个功能', () => {
    // 实测 2 篇评论页上「私密」「仅自己」「可见」一个字都没有，连容器都不存在。
    // 让它们进「说不准」的话，每次部署都会挂着两条谁也处理不了的东西。
    const b = restrictedNotes([rec('review', '1', { title: '一篇评论' })]);
    assert.equal(b.unsure.length, 0);
  });

  test('**私密但认不出是谁设的 → author，不是 platform**', () => {
    // platform 要正面证据（豆瓣那条通告）。反过来默认的话，一篇作者自己藏的日记
    // 会被说成「豆瓣锁的」——那是在替用户编造一件豆瓣没做过的事。
    const b = restrictedNotes([rec('note', '1', { visibility: 'private' })]);
    assert.deepEqual(b.author.map((x) => x.id), ['1']);
    assert.equal(b.platform.length, 0);
  });

  test('取最后一条修订 —— 一篇日记可能是先公开、后来才被锁的', () => {
    const r = rec('note', '1', { visibility: 'public' });
    r.revisions.push({ fields: { title: '后来被锁了', visibility: 'private', restricted_by: 'platform' } });
    assert.deepEqual(restrictedNotes([r]).platform.map((x) => x.id), ['1']);
  });

  test('DROPPABLE 与实际的三栏一一对应', () => {
    // 少一栏的话 `--drop-notes=<那一栏>` 会被当成拼写错误挡下来，而用户看到的
    // 名单里明明有它。
    assert.deepEqual([...DROPPABLE].sort(), Object.keys(restrictedNotes([])).sort());
  });
});
