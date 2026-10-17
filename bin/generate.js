#!/usr/bin/env node
/**
 * canonical + bundle → 静态站源目录。**不联网。**
 *
 *   node bin/generate.js <canonical 目录> <bundle 目录> [产出目录] [--account=<uid>] [--all-accounts]
 */

import { avatarNotice } from '../src/avatar.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/generate.js';
import { readCanonical, findCanonicalDirs, accountsInCanonical } from '../src/canonical.js';
import { parseCliArgs } from '../src/cli-args.js';

const args = process.argv.slice(2);
let parsed;
try { parsed = parseCliArgs(args); } catch (error) {
  console.error(error.message);
  process.exit(2);
}
// **默认带上那个最小 Hugo 骨架**，让产出目录直接能跑起来。
// 不想要（比如要换成现成的主题）就 --no-theme。
const withTheme = !parsed.flags.has('--no-theme');
const { siteTitle, account } = parsed;
const allAccounts = parsed.flags.has('--all-accounts');
const [canonDir, bundlesDir, outDir = 'site-out'] = parsed.positionals;
if (!canonDir) {
  console.error('用法: node bin/generate.js <canonical 目录> <bundle 目录> [产出目录] [--account=<uid>] [--all-accounts] [--no-theme] [--site-title=<标题>]');
  console.error('  --account=<uid>  只生成指定账号的站点（解决多账号混合问题）');
  console.error('  --all-accounts   自动按账号分流，分别生成到 <产出目录>/<uid>/');
  console.error('  --no-theme       不带 Hugo 骨架，只生成 content/ 与 static/');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));

function generateSingle(cDir, targetOutDir, accountUid) {
  const t0 = Date.now();
  let canonical;
  try {
    canonical = readCanonical(cDir, accountUid ? { account: accountUid } : {});
  } catch (err) {
    console.error(`\n✖ ${err.message}`);
    process.exit(1);
  }

  let r;
  try {
    r = generate({
      canonical,
      bundlesDir,
      outDir: targetOutDir,
      themeDir: withTheme ? join(HERE, '..', 'theme', 'hugo') : null,
      siteTitle,
      sourceRepo: parsed.sourceRepo,
      includePrivate: parsed.flags.has('--include-private'),
      account: accountUid,
    });
  } catch (err) {
    console.error(`\n✖ ${err.message}`);
    process.exit(1);
  }

  const avatarWarning = avatarNotice(r.avatar);
  if (avatarWarning) console.log(`   ⚠ ${avatarWarning}`);

  console.log(
    `页面 ${r.pages}（标记 ${r.marks} · 长文 ${r.longform} · 广播 ${r.broadcasts} 条归入 ${r.broadcastMonths} 个月`
    + `${r.albums ? ` · 相册 ${r.albums}` : ''}${r.groupTopics || r.groupJoins ? ` · 小组 ${r.groupTopics} 话题/${r.groupJoins} 加入` : ''}）`
    + ` · 图片 ${r.images.written} 张 · ${Date.now() - t0} ms → ${targetOutDir}/`,
  );

  console.log(`   搜索索引 ${r.searchRows} 条（${Math.round(r.searchBytes / 1024)} KB，gzip 后 ${Math.round(r.searchGzip / 1024)} KB）`);

  if (r.theme) {
    console.log(`\n带上了那个最小 Hugo 骨架。装了 hugo 的话现在就能看：`);
    console.log(`   cd ${targetOutDir} && hugo server`);
    console.log('   骨架只是个起点——删掉 layouts/ 换任何一个现成主题，content/ 与 static/ 一个字都不用动。');
  }

  if (r.images.unreadable?.length) {
    console.log(`\n⚠ 有 ${r.images.unreadable.length} 张图在档案里，但取不出来（段文件那一段解压不开）：`);
    for (const u of r.images.unreadable.slice(0, 5)) {
      console.log(`   ${u.captureId}  ${u.url}`);
      console.log(`      ${u.dir}  —— ${u.error}`);
    }
    if (r.images.unreadable.length > 5) console.log(`   …另有 ${r.images.unreadable.length - 5} 张`);
    console.log('  这不是抓漏了，是这份档案的字节坏了。重抓没有用，要做的是：');
    console.log('    1. 拿原始拷贝重新解压 / 重新导入一次；');
    console.log('    2. 跑一遍完整性检查，看还有没有别的地方也坏了：');
    console.log('       node ../doubak-data-parser/bin/verify.js <bundle 目录>');
  }

  if (r.images.remote.length) {
    console.log(`\n⚠ 有 ${r.images.remote.length} 张图没能从档案里取到，页面上留的是 doubanio 的地址：`);
    for (const u of r.images.remote.slice(0, 5)) console.log('  ', u);
    if (r.images.remote.length > 5) console.log(`   …另有 ${r.images.remote.length - 5} 张`);
    console.log('  这几张要豆瓣还在才看得见。想补齐的话：重新抓一次，然后拿新档案再生成一遍。');
  }
}

const foundDirs = findCanonicalDirs(canonDir);
if (foundDirs.length === 0) {
  console.error(`${canonDir} 看着不像 canonical 目录（所有已知 NDJSON 都没有记录）`);
  process.exit(1);
}

if (foundDirs.length === 1) {
  const resolvedDir = foundDirs[0];
  if (resolvedDir !== canonDir) {
    console.log(`ℹ 自动定位到子目录中的 canonical 存档：${resolvedDir}`);
  }

  if (account) {
    generateSingle(resolvedDir, outDir, account);
  } else if (allAccounts) {
    const whole = readCanonical(resolvedDir);
    const accountsMap = accountsInCanonical(whole);
    const uids = [...accountsMap.keys()].filter((k) => k && k !== 'unknown');
    if (uids.length <= 1) {
      generateSingle(resolvedDir, outDir, uids[0] ?? null);
    } else {
      console.log(`\n发现 ${uids.length} 个账号的数据（${uids.join('、')}），按账号分流生成站点：`);
      for (const uid of uids) {
        const accOutDir = join(outDir, uid);
        console.log(`\n========================================`);
        console.log(`正在为账号 ${uid} 生成站点 → ${accOutDir}/`);
        console.log(`========================================`);
        generateSingle(resolvedDir, accOutDir, uid);
      }
    }
  } else {
    generateSingle(resolvedDir, outDir, null);
  }
} else {
  // 发现多个子目录包含 canonical 存档
  if (account) {
    let matchedDir = null;
    for (const d of foundDirs) {
      try {
        readCanonical(d, { account });
        matchedDir = d;
        break;
      } catch {}
    }
    if (!matchedDir) {
      console.error(`\n✖ 在发现的 ${foundDirs.length} 个 canonical 子目录中均未找到账号 ${account}。`);
      process.exit(1);
    }
    console.log(`ℹ 锁定到匹配账号 ${account} 的子目录：${matchedDir}`);
    generateSingle(matchedDir, outDir, account);
  } else if (allAccounts) {
    console.log(`\n发现 ${foundDirs.length} 个包含 canonical 存档的子目录，按账号分流生成站点：`);
    for (const d of foundDirs) {
      const whole = readCanonical(d);
      const accountsMap = accountsInCanonical(whole);
      const uid = [...accountsMap.keys()][0] ?? basename(d);
      const accOutDir = join(outDir, uid);
      console.log(`\n========================================`);
      console.log(`正在为子目录 ${d}（账号 ${uid}）生成站点 → ${accOutDir}/`);
      console.log(`========================================`);
      generateSingle(d, accOutDir, uid);
    }
  } else {
    console.error(`✖ 发现多个子目录包含 canonical 存档（${foundDirs.join('、')}）。`);
    console.error('  请按账号分开生成站点。请使用 --account <uid> 指定账号，或使用 --all-accounts 批量生成。');
    process.exit(1);
  }
}
