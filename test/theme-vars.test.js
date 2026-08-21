/**
 * 主题里引用的每一个 CSS 变量，都必须真的定义过。
 *
 * 这一条是被一个 bug 逼出来的：搜索页的内联 <style> 里写着 `--accent`、`--dim`、
 * `--fg` 三个 site.css 从来没有定义过的名字。CSS 遇到取不到值的 var()，
 * 处理方式是**「在计算值这一步作废」**——不是报错，也不是退回上一条声明，
 * 而是当作该属性没写过。于是：
 *
 *     .hit mark { background: var(--accent); color: var(--bg); }
 *
 * 底色成了透明（background 不继承，作废即回到初始值），字色是 --bg 也就是白色。
 * 白底白字，**搜索命中的那几个字整段消失**，而页面其余部分完全正常。
 * 没有告警、没有控制台报错、Hugo 构建照样成功——正是这个项目反复栽进去的那一类。
 *
 * 变量名的拼写错误只能静态查：跑起来也不会抛，只会看着不对。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const THEME = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'hugo');
const CSS = join(THEME, 'static', 'site.css');

/** 主题下所有可能写 CSS 的文件。**整个目录一起读**，不是只读认识的那几个 —— */
/*  下一个内联 <style> 会落在哪个模板里，现在并不知道。 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(css|html)$/.test(p)) out.push(p);
  }
  return out;
}

const FILES = walk(THEME);
const css = readFileSync(CSS, 'utf-8');

/** `--x: …` 形式的定义。取自 site.css，明暗两套都算。 */
function definedIn(text) {
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/** `var(--x)` 形式的引用，连它所在的文件一起记下来，报错时能直接定位。 */
function referencesIn(text) {
  return [...text.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
}

describe('主题的 CSS 变量', () => {
  test('**引用到的每一个都定义过** —— 拼错不会报错，只会静默地不生效', () => {
    const defined = definedIn(css);
    const missing = [];

    for (const file of FILES) {
      const where = relative(THEME, file);
      for (const name of referencesIn(readFileSync(file, 'utf-8'))) {
        if (!defined.has(name)) missing.push(`${where}: var(${name})`);
      }
    }

    assert.deepEqual(missing, [], `这些变量没有定义过：\n  ${missing.join('\n  ')}`);
  });

  test('这个检查不能是空转的', () => {
    // 第一版差点写成恒真：正则若一个文件都没读到，上面那条照样绿。
    assert.ok(FILES.length >= 5, `只扫到 ${FILES.length} 个文件，路径大概错了`);
    const total = FILES.reduce((n, f) => n + referencesIn(readFileSync(f, 'utf-8')).length, 0);
    assert.ok(total >= 50, `只扫到 ${total} 处 var() 引用，正则大概错了`);
    assert.ok(definedIn(css).size >= 20, 'site.css 里的定义数不对');
  });

  test('**明暗两套都要有高亮色** —— 只定义一套，就是让一半的人看不见命中', () => {
    const at = css.indexOf('prefers-color-scheme: dark');
    assert.ok(at > 0, '深色模式那一段不见了');
    const light = definedIn(css.slice(0, at));
    const dark = definedIn(css.slice(at));

    for (const name of ['--hl', '--hl-text']) {
      assert.ok(light.has(name), `浅色模式缺 ${name}`);
      assert.ok(dark.has(name), `深色模式缺 ${name}`);
    }
  });

  test('**高亮的底色和字色必须是一对** —— 底色借了别处、字色写死，就是白底白字', () => {
    const html = readFileSync(join(THEME, 'layouts/_default/search.html'), 'utf-8');
    // 用 assert.ok 而不是 assert.match：后者失败时会把整个模板打进报告里，
    // 于是真正的那一行被埋在几百行输出中间。
    assert.ok(
      /\.hit mark \{ background: var\(--hl\); color: var\(--hl-text\);/.test(html),
      '命中高亮必须同时取 --hl 与 --hl-text',
    );
    // 出事的那一版写的是 color: var(--bg)：浅色模式下就是白字。
    assert.ok(
      !/\.hit mark \{[^}]*color: var\(--bg\)/.test(html),
      '字色不能取 --bg —— 那是页面底色',
    );
  });
});
