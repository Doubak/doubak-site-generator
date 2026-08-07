/**
 * front matter 序列化。
 *
 * ## 为什么这个文件的测试最密
 *
 * 它序列化的是**用户写的字**，而那些字里什么都有：冒号、引号、井号、换行、emoji、
 * 颜文字 `_(:з」∠)_`、前导空格、看起来像布尔值的 `no`、看起来像数字的 `007`。
 *
 * 任何一处转义漏掉，产出的就是坏掉的 front matter——而静态站生成器多半只会报一句
 * 语法错误，指着一个几千行文件里的某一行。用户根本无从判断是自己的短评还是工具的锅。
 *
 * 所以这里不只测「能不能生成」，还要**把生成的东西读回来**，确认读回来的与写进去的
 * 一模一样。往返才是真正要守的性质。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { frontMatter } from '../src/yaml.js';

/**
 * 一个只够验证往返的极简 YAML 读取器。
 *
 * **刻意与被测代码用不同的思路写**：如果两边共享同一个理解，往返测试就只能证明
 * 「我前后一致地错」。这里按行扫、只认它自己写出来的那几种形态。
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  assert.equal(lines[0], '---');
  const out = {};
  let i = 1;
  const unq = (s) => (s.startsWith('"')
    ? JSON.parse(s.replace(/\\x([0-9a-f]{2})/g, (_, h) => `\\u00${h}`))
    : s === 'null' ? null : s);

  while (i < lines.length && lines[i] !== '---') {
    const line = lines[i];
    const m = /^([A-Za-z0-9_]+): ?(.*)$/.exec(line);
    assert.ok(m, `读不懂这一行：${JSON.stringify(line)}`);
    const [, key, rest] = m;

    if (rest === '|-') {
      const block = [];
      i += 1;
      while (i < lines.length && (lines[i] === '' || lines[i].startsWith('  '))) {
        block.push(lines[i] === '' ? '' : lines[i].slice(2));
        i += 1;
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      out[key] = block.join('\n');
      continue;
    }
    if (rest === '') {
      const arr = [];
      i += 1;
      while (i < lines.length && lines[i].startsWith('  - ')) {
        arr.push(unq(lines[i].slice(4)));
        i += 1;
      }
      out[key] = arr;
      continue;
    }
    out[key] = rest === '[]' ? [] : unq(rest);
    i += 1;
  }
  return out;
}

/** @param {Record<string, unknown>} obj */
function roundTrip(obj) {
  return parseFrontMatter(frontMatter(obj));
}

describe('往返：写进去什么，读回来就是什么', () => {
  test('中文、emoji、颜文字', () => {
    const v = { comment: '玩了Open Beta大概10个小时 _(:з」∠)_ 😅 还行' };
    assert.deepEqual(roundTrip(v), v);
  });

  test('冒号、引号、井号、方括号 —— YAML 的特殊字符', () => {
    const v = { comment: 'a: b "c" #d [e] {f} & *g | > %h @i `j`' };
    assert.deepEqual(roundTrip(v), v);
  });

  test('反斜杠不会被吃掉', () => {
    const v = { comment: 'C:\\Users\\x 与 \\n 这个字面量' };
    assert.deepEqual(roundTrip(v), v);
  });

  test('多行正文', () => {
    const v = { body: '第一段\n\n第二段：带冒号\n第三段' };
    assert.deepEqual(roundTrip(v), v);
  });

  test('**前导空白的多行退回引号形式** —— 块标量会吃掉它', () => {
    // 块标量靠缩进定界，原文里的前导空格会被吃掉或让缩进错乱。
    const v = { body: '正常一行\n    缩进的一行\n又一行' };
    assert.deepEqual(roundTrip(v), v);
    assert.ok(!frontMatter(v).includes('|-'), '有前导空白时不该用块标量');
  });

  test('控制字符不丢 —— 它们确实出现在从网页粘来的字里', () => {
    const v = { comment: `退格\u0008与竖表\u000b` };
    assert.deepEqual(roundTrip(v), v);
  });
});

describe('那些「看起来像别的类型」的字符串', () => {
  test('**`NO` 不能变成 false** —— YAML 最有名的坑', () => {
    // 挪威国家代码 NO 变成 false 是 YAML 的经典事故。豆瓣标签里出现单个词
    // 完全不稀奇。
    for (const s of ['no', 'NO', 'yes', 'Y', 'n', 'true', 'False', 'on', 'off', 'null', '~']) {
      assert.deepEqual(roundTrip({ tag: s }), { tag: s }, s);
    }
  });

  test('`007` 不能变成 7', () => {
    for (const s of ['007', '1e3', '.5', '-0', '1_000']) {
      assert.deepEqual(roundTrip({ tag: s }), { tag: s }, s);
    }
  });

  test('真正的数字与布尔仍然是裸的', () => {
    const text = frontMatter({ rating: 5, deleted: true });
    assert.match(text, /^rating: 5$/m);
    assert.match(text, /^deleted: true$/m);
  });
});

describe('结构', () => {
  test('数组，含空数组', () => {
    assert.deepEqual(roundTrip({ tags: ['经典', '美国'] }), { tags: ['经典', '美国'] });
    assert.deepEqual(roundTrip({ tags: [] }), { tags: [] });
  });

  test('**null 与「没有这个键」是两件事**', () => {
    // 一路从 canonical 保过来的语义：字段缺席 = 没抽到；字段是 null = 上游确实没有。
    const text = frontMatter({ rating: null, comment: undefined });
    assert.match(text, /^rating: null$/m);
    assert.ok(!text.includes('comment'), 'undefined 不该写出来');
  });

  test('空串不是 null', () => {
    assert.deepEqual(roundTrip({ a: '' }), { a: '' });
  });

  test('键的顺序原样保留 —— 产出要能逐字节复现', () => {
    // 投影是缓存，随时可以整个删掉重生成。而一个每次都全变的缓存等于没有缓存：
    // git diff 里全是噪音，真正变了的东西反而看不见。
    const a = frontMatter({ z: 1, a: 2, m: 3 });
    const b = frontMatter({ z: 1, a: 2, m: 3 });
    assert.equal(a, b);
    assert.ok(a.indexOf('z:') < a.indexOf('a:'), '不该按字母重排');
  });
});
