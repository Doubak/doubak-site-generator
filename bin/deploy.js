#!/usr/bin/env node
/**
 * 把构建好的站点铺进一个**已存在的仓库目录**，让 GitHub Pages 能直接发布。
 *
 *   node bin/deploy.js <canonical 目录> <bundle 目录> <仓库目录> [--dry-run] [--drop-notes=…]
 *
 * ## 为什么不能直接推产出目录
 *
 * `npm run site` 产出的是一个 **Hugo 工程**：`content/` `layouts/` `hugo.toml`
 * `static/` `public/`。而 GitHub Pages 发布的是**仓库根**——推上去它会在根目录
 * 找 `index.html`，找不到。要发布的其实只是 `public/` 里的东西。
 *
 * 所以这一步做的是：构建，然后把 `public/` 的内容平铺到仓库根，顺带
 *
 *   - 写一个 `.nojekyll`。不写的话 GitHub 会拿 Jekyll 再处理一遍，
 *     而下划线开头的路径会被它**静默吞掉**（现在没有，但这不该靠运气）。
 *   - 保住 `CNAME`、`LICENSE`、`README.md`、`.git`、`.github`、`sitemap.xml`
 *     ——它们是仓库的东西，不是这个生成器铺下去的。
 *   - 删掉上一次部署留下、这次不该再有的文件。**不删的话会留下幽灵页面**：
 *     有固定链接、能打开、内容看着正常，只是早就不在数据里了。
 *
 * ## 先看清楚要公开什么
 *
 * 这一步是**把私人档案变成公开网页**，而且不可逆——推出去就被抓取、被缓存了。
 * 所以默认先把「会公开什么」摆出来，`--dry-run` 只看不写。
 */

import {
  existsSync, readdirSync, statSync, cpSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/generate.js';
import { ensureHugo } from '../src/hugo-bin.js';
import { readCanonical } from '../src/canonical.js';
import { privateContent, withoutPrivate, DROPPABLE, PRIVATE_BY_DEFAULT } from '../src/private.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceRepo = args.find((a) => a.startsWith('--source-repo='))?.slice('--source-repo='.length) || null;
const [canonDir, bundlesDir, repoDir] = args.filter((a) => !a.startsWith('--'));

if (!canonDir || !bundlesDir || !repoDir) {
  console.error('用法: node bin/deploy.js <canonical 目录> <bundle 目录> <仓库目录> [--dry-run] [--source-repo=<url>]');
  console.error('  --include-private   把豆瓣上不公开的东西也发出去（私密日记、私密豆列、只有自己');
  console.error('                      看得见的广播），页面上带一枚锁标。**默认不发**');
  console.error('  --drop-notes=author,platform,unsure  再额外去掉哪几类日记（或 all）。与上面那个');
  console.error('                      方向相反：一个放宽，一个收紧，显式写的压过默认');
  console.error('  --source-repo=<url>  页脚加一行「这个站点的源码」，指这一份站点自己的仓库；默认没有。');
  process.exit(2);
}
if (!existsSync(repoDir)) {
  // **不新建。** 目标该是一个已经存在的、有 .git 的仓库；自动创建只会让
  // 打错一个路径变成「往某个空目录里倒了 3000 个文件」。
  console.error(`${repoDir} 不存在。请先 clone 那个仓库。`);
  process.exit(1);
}

/**
 * 仓库自己的东西，不属于站点，任何时候都不动。
 *
 * **`sitemap.xml` 在这里，是因为它由仓库那边的 CI 生成，不由这个生成器产出。**
 * 一开始它不在名单里，理由听着也成立：既然是别处生成的，清掉之后那边会重新生成。
 * 实际发生的是——2026-08-20 真删了一次——那条链路有一段真空：重新生成要等人合并
 * 一个 PR，在那之前线上站点没有 sitemap，而搜索引擎不会等。
 *
 * 一般规则：**清「上一次留下的残留」，只能清自己上一次铺下去的东西。**
 * 别的流程放进仓库的产物，这里既不知道它怎么来的，也不知道它多久能回来，
 * 那就不该替它做主。
 */
const KEEP = new Set([
  '.git', '.gitignore', 'CNAME', 'LICENSE', 'README.md', '.github', 'sitemap.xml',
]);

// ── ① 构建到一个暂存目录（不是仓库目录——构建中途失败不该把仓库搞成半成品）
const stage = join(HERE, '..', '.deploy-stage');
rmSync(stage, { recursive: true, force: true });

const canonical = readCanonical(canonDir);

// **拿原始那份点名，不是筛过的那份。** 铺进仓库是不可逆的，而预演是它前面唯一
// 一道——印「这几条被留下了」和「这几条被去掉了」都要从完整的数据里数。
const priv = privateContent(canonical);
const includePrivate = args.includes('--include-private');
const drop = (args.find((a) => a.startsWith('--drop-notes='))?.slice('--drop-notes='.length) ?? '')
  .split(',').map((x) => x.trim()).filter(Boolean);
for (const d of drop) {
  if (d !== 'all' && !DROPPABLE.includes(d)) {
    console.error(`--drop-notes 只认 ${DROPPABLE.join(' / ')} / all，收到 ${d}`);
    process.exit(2);
  }
}

const t0 = Date.now();
const r = generate({
  canonical,
  includePrivate,
  dropNotes: drop,
  bundlesDir,
  outDir: stage,
  themeDir: join(HERE, '..', 'theme', 'hugo'),
  sourceRepo,
});
console.log(`① 生成 ${r.pages} 页 · 图片 ${r.images.written} 张 · ${Date.now() - t0} ms`);

const { path: hugo } = await ensureHugo({ cacheDir: join(HERE, '..', '.hugo'), log: (m) => console.log(`   ${m}`) });
const built = spawnSync(hugo, ['--quiet'], { cwd: stage, stdio: 'inherit' });
if (built.status !== 0) {
  console.error('Hugo 构建失败，仓库目录一个字都没动。');
  process.exit(built.status ?? 1);
}
const publicDir = join(stage, 'public');
console.log('② 构建完成');

// ── ② 摆出来：要公开什么
const files = walk(publicDir);
const byKind = {};
for (const f of files) {
  const k = /\.(jpg|jpeg|png|gif|webp)$/i.test(f) ? '图片' : /\.html$/i.test(f) ? '页面' : '其他';
  byKind[k] = (byKind[k] ?? 0) + 1;
}
const bytes = files.reduce((n, f) => n + statSync(join(publicDir, f)).size, 0);

console.log('\n③ 这次会公开：');
for (const [k, n] of Object.entries(byKind)) console.log(`   ${k} ${n}`);
console.log(`   合计 ${(bytes / 1024 / 1024).toFixed(1)} MB → ${resolve(repoDir)}`);

// ── ④ 豆瓣上不公开的东西，逐条点名。**要点名而不是筛完了事**：铺进仓库不可逆，
// 而这是它前面唯一一道，所以「发了什么」和「没发什么」都要说得出来。
{
  const notes = priv.notes;
  const dropped = new Set(drop.includes('all') ? DROPPABLE : drop);
  /** 这一栏这次到底发没发。 */
  const 发了 = (k) => !dropped.has(k) && (includePrivate || !PRIVATE_BY_DEFAULT.includes(k));
  const total = notes.author.length + notes.platform.length + notes.unsure.length
    + priv.doulists.length + priv.broadcasts.length;

  if (total) {
    console.log(`\n④ 有 ${total} 项在豆瓣上不是公开的`
      + `（${includePrivate ? '这一次 --include-private 全部照发' : '默认不发，除了豆瓣锁掉的那一类'}）：`);

    const say = (list, head, tail, out) => {
      if (!list.length) return;
      console.log(`\n   ${head}（${list.length}）—— ${out ? '**这次发出去了**' : '这次没发'}`);
      console.log(`   ${tail}`);
      for (const x of list) {
        console.log(`     · ${x.title ?? JSON.stringify((x.text ?? '').slice(0, 40))}`);
        if (x.notice) console.log(`       豆瓣的说法：${x.notice}`);
      }
    };
    say(notes.author, '日记 · 作者自己设成「仅自己可见」',
      '发出去 = 把他藏起来的东西公开了，而且撤不回来。', 发了('author'));
    say(notes.platform, '日记 · 豆瓣锁掉的',
      '**它本来就是公开的**，是豆瓣把它关掉的——发出去正是这份存档要做的事；不发 = 替豆瓣二次消音。',
      发了('platform'));
    say(notes.unsure, '日记 · 说不准',
      '页面上认不出来（多半是豆瓣改版），或者这份 canonical 早于这个字段。「认不出来」不是「确认公开」。',
      发了('unsure'));
    say(priv.doulists, '豆列 · 私密', '豆瓣上只有你自己看得见。', includePrivate);
    // **广播这一条是这次的起因，所以话要说重。** 豆瓣发一篇私密日记时会同步一条
    // 广播，正文一字不差——日记那一页发没发根本不重要，内容从旁边这条路漏出去了。
    say(priv.broadcasts, '广播 · 只有你自己看得见',
      '豆瓣发私密日记时会同步一条，正文一字不差——**它绕过日记那一侧的所有开关**。',
      includePrivate);

    console.log(`\n   放宽：--include-private（全发，页面上带锁标）`);
    console.log(`   收紧：--drop-notes=${DROPPABLE.join(',')} 里挑（可多选，或 all）`);
    console.log('   （NeoDB 导出那边同一件事：豆瓣锁的照常公开，作者自己藏的收成仅提及者可见。）');
  }

  // **「这份 canonical 根本没有这个信息」与「没有私密的东西」是两回事。**
  // 不说的话，用老 canonical 生成的人会以为已经查过了。
  if (priv.unknownPrivacy.length) {
    const 名 = { broadcasts: '广播', doulists: '豆列' };
    console.log(`\n   ⚠ 这份 canonical 里${priv.unknownPrivacy.map((k) => 名[k] ?? k).join('、')}没有可见性信息`);
    console.log('     （解析器 0.13.0 才开始写它），所以这一类**没有筛**，全部照发。');
    console.log('     重跑一次解析器就有了——页面本来就在档案里，不用重新抓豆瓣。');
  }
}

const stale = readdirSync(repoDir).filter((n) => !KEEP.has(n));
if (stale.length) {
  console.log(`\n   会先清掉仓库里上一次留下的 ${stale.length} 项：${stale.slice(0, 6).join(' ')}${stale.length > 6 ? ' …' : ''}`);
  console.log(`   保留：${[...KEEP].filter((n) => existsSync(join(repoDir, n))).join(' ')}`);
}

if (dryRun) {
  console.log('\n--dry-run：什么都没写。');
  process.exit(0);
}

// ── ③ 铺进仓库
for (const n of stale) rmSync(join(repoDir, n), { recursive: true, force: true });
for (const n of readdirSync(publicDir)) {
  cpSync(join(publicDir, n), join(repoDir, n), { recursive: true });
}
// Jekyll 会静默吞掉下划线开头的路径。现在没有，但这不该靠运气。
writeFileSync(join(repoDir, '.nojekyll'), '');
rmSync(stage, { recursive: true, force: true });

console.log(`\n④ 铺好了。仓库目录已就绪，`
  + `\n   git -C ${repoDir} add -A && git -C ${repoDir} commit && git -C ${repoDir} push`);

/** 列出目录下所有文件的相对路径。 */
function walk(root, prefix = '') {
  const out = [];
  for (const n of readdirSync(join(root, prefix))) {
    const rel = prefix ? join(prefix, n) : n;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}
