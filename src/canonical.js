/**
 * 从一个 canonical 目录读出全部记录。
 *
 * ## 为什么这件小事值得单独一个模块
 *
 * 因为它原来在**三个入口里各写了一份**（`bin/generate.js`、`bin/site.js`、
 * `bin/deploy.js`），四行一模一样的 `read('xxx.ndjson')`。加第五种记录（豆列）的
 * 时候只改了其中一个——于是 `npm run md` 出得来豆列页，`npm run site` 与
 * `npm run deploy` 出不来，**而且三条路都不报错**：缺的那一类被读成 `[]`，
 * 生成器照常跑完，只是少了几十页。
 *
 * 这与 `SECTION_ORDER` 那次是同一种形状：一份清单抄了三处，加东西时漏掉一处，
 * 没有任何东西会红。区别是那次有测试钉着两处相等，这次没有。
 *
 * 所以名单只留一份，三个入口都从这里取。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * canonical 的五类记录。
 *
 * **顺序无所谓，齐全才要紧。** 新增一类记录时改这里一处即可；
 * `test/canonical-load.test.js` 会检查没有哪个入口自己另写了一份名单。
 */
export const CANONICAL_FILES = /** @type {const} */ ({
  marks: 'marks.ndjson',
  subjects: 'subjects.ndjson',
  longform: 'longform.ndjson',
  broadcasts: 'broadcasts.ndjson',
  doulists: 'doulists.ndjson',
  albums: 'albums.ndjson',
  group_topics: 'group_topics.ndjson',
  group_joins: 'group_joins.ndjson',
  profile: 'profile.ndjson',
});

/**
 * 递归寻找所有包含 canonical NDJSON 文件的目录。
 * @param {string} root
 * @returns {string[]}
 */
export function findCanonicalDirs(root) {
  if (!existsSync(root)) return [];

  const isDirectCanonical = (dir) => {
    return Object.values(CANONICAL_FILES).some((file) => existsSync(join(dir, file)));
  };

  if (isDirectCanonical(root)) return [root];

  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        const sub = join(dir, e.name);
        if (isDirectCanonical(sub)) {
          results.push(sub);
        } else {
          walk(sub);
        }
      }
    }
  }

  walk(root);
  if (results.length > 0) return results.sort();
  return [root];
}

/**
 * 收集 canonical 中出现的所有账号信息。
 * @param {object} canonical
 * @returns {Map<string, {user_id: string, username?: string, nickname?: string}>}
 */
export function accountsInCanonical(canonical) {
  const accounts = new Map();
  const check = (acc) => {
    const uid = acc?.user_id;
    if (uid && uid !== 'unknown' && !accounts.has(String(uid))) {
      accounts.set(String(uid), acc);
    }
  };
  for (const m of canonical.marks ?? []) check(m.account);
  for (const b of canonical.broadcasts ?? []) check(b.account);
  for (const l of canonical.longform ?? []) check(l.account);
  for (const d of canonical.doulists ?? []) check(d.account);
  for (const a of canonical.albums ?? []) check(a.account);
  for (const g of canonical.group_topics ?? canonical.groupTopics ?? []) check(g.account);
  for (const j of canonical.group_joins ?? canonical.groupJoins ?? []) check(j.account);
  for (const p of Array.isArray(canonical.profile) ? canonical.profile : [canonical.profile]) check(p?.account ?? p);
  return accounts;
}

/**
 * 按指定账号 UID 过滤 canonical 记录。
 * @param {object} canonical
 * @param {string} targetUid
 * @returns {object}
 */
export function filterCanonicalByAccount(canonical, targetUid) {
  const target = String(targetUid);
  const filterArr = (arr) => (arr ?? []).filter((item) => {
    const id = item?.account?.user_id ?? item?.user_id;
    return id ? String(id) === target : true;
  });

  return {
    ...canonical,
    marks: filterArr(canonical.marks),
    broadcasts: filterArr(canonical.broadcasts),
    longform: filterArr(canonical.longform),
    doulists: filterArr(canonical.doulists),
    albums: filterArr(canonical.albums),
    group_topics: filterArr(canonical.group_topics ?? canonical.groupTopics),
    group_joins: filterArr(canonical.group_joins ?? canonical.groupJoins),
    profile: filterArr(canonical.profile),
    subjects: canonical.subjects ?? [],
  };
}

/**
 * @param {string} dir canonical 目录
 * @param {{account?: string}} [opts]
 * @returns {Record<string, object[]>}
 */
export function readCanonical(dir, opts = {}) {
  /** @type {Record<string, object[]>} */
  const out = {};
  for (const [key, name] of Object.entries(CANONICAL_FILES)) {
    const p = join(dir, name);
    out[key] = existsSync(p)
      ? readFileSync(p, 'utf-8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  }
  if (opts.account) {
    const target = String(opts.account);
    const accounts = accountsInCanonical(out);
    const uids = [...accounts.keys()].filter((k) => k && k !== 'unknown');
    if (!uids.includes(target)) {
      throw new Error(`指定的账号 ${target} 在 canonical 数据中不存在。已发现账号：${uids.length ? uids.join('、') : '（无已知账号）'}`);
    }
    return filterCanonicalByAccount(out, target);
  }
  return out;
}
