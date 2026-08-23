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
    // 用 assert.ok 而不是 assert.match：后者失败时会把整个文件打进报告里，
    // 于是真正的那一行被埋在几百行输出中间。
    assert.ok(
      /\.hit mark \{ background: var\(--hl\); color: var\(--hl-text\);/.test(css),
      '命中高亮必须同时取 --hl 与 --hl-text',
    );
    // 出事的那一版写的是 color: var(--bg)：浅色模式下就是白字。
    assert.ok(
      !/\.hit mark \{[^}]*color: var\(--bg\)/.test(css),
      '字色不能取 --bg —— 那是页面底色',
    );
    // 也不能写死：#1a1c1a 在深色模式下是黑字压深黄底。
    assert.ok(
      !/\.hit mark \{[^}]*color: #/.test(css),
      '字色不能写死颜色 —— 深浅两套模式得各取各的',
    );
  });

  test('**搜索页的样式只有一份** —— 两份同名选择器会交织，而模板里那份会漂', () => {
    // 曾经 site.css 与 search.html 的内联 <style> 各有一份 .hit / #q / .idx，
    // 内联那份在文档顺序上靠后。页面上生效的既不是任何一份，而是两份交织的
    // 结果：#q 的圆角来自内联、字号来自 site.css。命中高亮整段隐形那次，
    // 出错的正是模板里那份——没人会去模板里找样式。
    const templates = FILES.filter((f) => f.endsWith('.html'));
    assert.ok(templates.length >= 5, `只扫到 ${templates.length} 个模板，路径大概错了`);

    const offenders = [];
    for (const file of templates) {
      const text = readFileSync(file, 'utf-8');
      // 真的内联样式才算：只写了 <style> 四个字的注释不算。
      const a = text.indexOf('<style>');
      const b = text.indexOf('</style>');
      if (a >= 0 && b > a) offenders.push(`${relative(THEME, file)}: 内联 <style>`);
    }
    assert.deepEqual(offenders, [], `样式要写在 site.css 里：\n  ${offenders.join('\n  ')}`);

    // 这条检查得确认自己真的看见了那些选择器，否则 site.css 被清空也照样绿。
    for (const sel of ['.hit mark', '#q:focus', '.idx-loading .bar']) {
      assert.ok(css.includes(sel), `site.css 里找不到 ${sel}，样式没搬全`);
    }
  });
});
