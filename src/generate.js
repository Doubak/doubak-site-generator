/**
 * 主流程：canonical + bundle → 一个能交给静态站生成器的目录。
 *
 * ## 两个输入，一个都不能少
 *
 * canonical 说「有什么」，bundle 里是图片的字节（canonical 是文本，不装二进制）。
 * 两者都在本地，所以**整个过程零网络请求**——站点也是派生数据，那条不变量在这里
 * 同样成立。
 *
 * ## 产出是缓存，可以整个删掉重来
 *
 * 所以每次生成都**先清空再写**。不清的话，上次生成的、这次已经不该存在的页面
 * 会留在那儿——而那种「幽灵页面」在静态站里格外难发现：它有固定链接、能打开、
 * 内容看着也正常，只是早就不在数据里了。
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { project, groupMarks } from './projection.js';
import { markPage, longformPage, markPath, longformPath, verb } from './markdown.js';
import { indexImages, exportImages } from './images.js';
import { frontMatter } from './yaml.js';

/** 媒介的中文名。**唯一的一份**，与扩展那边同源。 */
const MEDIUM_NAMES = {
  movie: '影视', book: '书', music: '音乐', game: '游戏', drama: '舞台剧',
};

/**
 * @param {object} opts
 * @param {{marks: object[], subjects: object[], longform: object[]}} opts.canonical
 * @param {string} [opts.bundlesDir] 有它才导出图片
 * @param {string} opts.outDir
 * @param {boolean} [opts.clean] 先清空产出目录，默认 true
 */
export function generate({ canonical, bundlesDir, outDir, clean = true }) {
  const p = project(canonical);

  if (clean) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'content'), { recursive: true });

  // ── 图片
  let paths = {};
  /** @type {Record<string, string>} 作品 id → 本地封面路径 */
  let coverBySubject = {};
  let imageStats = { written: 0, missing: [] };
  if (bundlesDir) {
    const wanted = new Set();
    for (const m of p.marks) if (m.coverUrl) wanted.add(m.coverUrl);
    // 正文里内嵌的图：它们在正文文本里以 URL 出现，所以扫一遍正文。
    for (const r of p.longform) {
      for (const m of (r.body ?? '').matchAll(/https:\/\/[a-z0-9.]*doubanio\.com\/[^\s"'<>)）]+/g)) {
        wanted.add(m[0]);
      }
    }
    const res = exportImages({
      index: indexImages(bundlesDir),
      wanted,
      // **按作品 id 再找一遍封面。** canonical 里的 cover_url 取自列表页缩略图，
      // 而档案里存的是详情页封面——多数媒介两者恰好同一个文件，舞台剧那种不是。
      // 只按 URL 找会漏掉 95 张明明就在档案里的图。
      wantedBySubject: new Set(p.marks.map((m) => m.subjectId)),
      outDir: join(outDir, 'static'),
    });
    paths = res.paths;
    coverBySubject = res.bySubject;
    // 按 URL 找不到、但按作品 id 找到了的，不算缺——那是同一张图的两个尺寸。
    // 不筛掉的话「缺 95 张」会成为一条永远存在、且已经不成立的告警，
    // 而一条天天出现的假告警会让真的那条也被忽略。
    const coveredUrls = new Set(
      p.marks.filter((m) => res.bySubject[m.subjectId] && m.coverUrl).map((m) => m.coverUrl),
    );
    imageStats = {
      written: res.written,
      // 占位图也不算缺。`/cuphead/`、`/f/` 是豆瓣的前端静态资源目录，抓取时就
      // **刻意不存**（那不是内容，而且每个没海报的作品都是同一张）。剩下的 6 张
      // 正是墓碑作品——它们本来就没有封面。
      //
      // 这一条与上面那条是同一个意思：**告警要么是真的，要么就不该出现。**
      // 一条永远在的假告警会让真的那条也被忽略。
      missing: res.missing.filter((u) => !coveredUrls.has(u) && !/\/(cuphead|f)\//.test(u)),
    };
  }

  // ── 页面
  const files = [];
  for (const m of p.marks) {
    // 按作品 id 找到的优先——那是档案里真的有的那一张。按 URL 找到的作为退路。
    const cover = coverBySubject[m.subjectId] ?? paths[m.coverUrl] ?? null;
    files.push([join('content', markPath(m)), markPage(m, { coverPath: cover })]);
  }
  for (const r of p.longform) {
    files.push([join('content', longformPath(r)), longformPage(r, { images: paths })]);
  }
  files.push(['content/_index.md', homePage(p)]);

  for (const [rel, text] of files) {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf-8');
  }

  return {
    pages: files.length,
    marks: p.marks.length,
    longform: p.longform.length,
    images: imageStats,
  };
}

/**
 * 首页。
 *
 * **只给数字，不给百分比，也不写「完整」。** 完整性的证据在 bundle 的 `crawl_state`
 * 里，投影这一层没有资格复述一个可能已经过期的结论——那与「coverage 不是完整性
 * 判据」是同一条规则。
 */
function homePage(p) {
  const groups = groupMarks(p.marks);
  const lines = [];

  for (const [medium, byStatus] of [...groups].sort()) {
    lines.push(`## ${MEDIUM_NAMES[medium] ?? medium}`, '');
    for (const [status, list] of [...byStatus].sort()) {
      lines.push(`- ${verb(medium, status)} ${list.length}`);
    }
    lines.push('');
  }

  const notes = p.longform.filter((r) => r.kind === 'note').length;
  const reviews = p.longform.filter((r) => r.kind === 'review').length;
  if (notes || reviews) {
    lines.push('## 长文', '', `- 日记 ${notes}`, `- 评论 ${reviews}`, '');
  }

  const deleted = p.marks.filter((m) => m.upstreamDeleted).length;
  if (deleted) {
    lines.push(
      '## 上游已删除',
      '',
      `有 ${deleted} 条标记指向豆瓣已经删掉的作品。标记本身还在——评分、标签、`
      + '短评都是你自己写的，它们没有跟着消失。',
      '',
    );
  }

  return frontMatter({ title: '我的豆瓣存档', douban_kind: 'index' }) + '\n' + lines.join('\n');
}
