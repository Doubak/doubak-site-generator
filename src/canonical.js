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

import { existsSync, readFileSync } from 'node:fs';
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
});

/**
 * @param {string} dir canonical 目录
 * @returns {Record<string, object[]>}
 */
export function readCanonical(dir) {
  /** @type {Record<string, object[]>} */
  const out = {};
  for (const [key, name] of Object.entries(CANONICAL_FILES)) {
    const p = join(dir, name);
    // **缺文件返回空数组，不抛。** 老档案解析出来的 canonical 里没有新增的那几类，
    // 而那不是错误——重跑一次解析器就有了。
    out[key] = existsSync(p)
      ? readFileSync(p, 'utf-8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  }
  return out;
}
