/** 实际运行 CLI，覆盖参数解析与建站入口；没有 Hugo 时用本地桩，绝不下载。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'doubak-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const canonical = join(dir, 'canonical');
  const bundles = join(dir, 'bundles');
  const bin = join(dir, 'bin');
  const deployRoot = join(dir, 'generator');
  for (const path of [canonical, bundles, bin]) mkdirSync(path);
  writeFileSync(join(bin, 'hugo'), '#!/bin/sh\n'
    + 'if [ "$1" = "version" ]; then printf "hugo v0.164.0\\n"; exit 0; fi\n'
    + 'mkdir -p public\nprintf "<html>CLI test</html>" > public/index.html\n', { mode: 0o755 });
  return {
    dir, canonical, bundles, out: join(dir, 'out'), stage: join(deployRoot, '.deploy-stage'),
    run: (entry, args) => {
      let root = ROOT;
      if (entry === 'deploy.js') {
        // 原样运行脚本，但让它的 .deploy-stage 在夹具目录里：不能清用户的预演产物，
        // 两份测试进程也不能争同一份暂存目录。
        if (!existsSync(deployRoot)) {
          mkdirSync(join(deployRoot, 'bin'), { recursive: true });
          copyFileSync(join(ROOT, 'bin/deploy.js'), join(deployRoot, 'bin/deploy.js'));
          copyFileSync(join(ROOT, 'package.json'), join(deployRoot, 'package.json'));
          for (const name of ['src', 'theme', '.hugo']) {
            if (existsSync(join(ROOT, name))) symlinkSync(join(ROOT, name), join(deployRoot, name), 'junction');
          }
        }
        root = deployRoot;
      }
      return spawnSync(process.execPath, [join(root, 'bin', entry), ...args], {
        encoding: 'utf-8', timeout: 30000,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
      });
    },
  };
}

for (const entry of ['generate.js', 'site.js']) {
  test(`${entry}：站名选项与 --include-private、--source-repo 可组合使用`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.canonical, 'longform.ndjson'), JSON.stringify({
      canonical_version: 'canonical/1.2', kind: 'note', upstream_id: '123',
      account: { user_id: '123', nickname: '日记作者' },
      revisions: [{ fields: { title: '私密日记', body: '正文', privacy: 'private', privacy_origin: 'author' } }],
    }) + '\n');
    let result = f.run(entry, [f.canonical, f.bundles, f.out, '--site-title=站名']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.out, 'content/note/123.md')), false);
    result = f.run(entry, [f.canonical, f.bundles, f.out, '--site-title', '站名',
      '--include-private', '--source-repo', 'https://example.com/archive']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.out, 'content/note/123.md')), true, '显式选项必须传给生成器');
    const toml = readFileSync(join(f.out, 'hugo.toml'), 'utf-8');
    assert.ok(toml.includes('title = "站名"'));
    assert.ok(toml.includes('sourceRepo = "https://example.com/archive"'));
    assert.ok(toml.includes('includePrivate = true'));
  });

  for (const form of ['equals', 'separate']) {
    test(`${entry}：${form} 标题参数不会移走位置参数`, (t) => {
      const f = fixture(t);
      const title = '自定义 标题';
      const args = form === 'equals'
        ? [f.canonical, `--site-title=${title}`, f.bundles, f.out]
        : ['--site-title', title, f.canonical, f.bundles, f.out];
      const result = f.run(entry, args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(f.out, 'content/_index.md'), 'utf-8'), /自定义 标题/);
      const toml = readFileSync(join(f.out, 'hugo.toml'), 'utf-8');
      assert.ok(toml.includes(`title = "${title}"`));
      if (entry === 'site.js') assert.ok(existsSync(join(f.out, 'public/index.html')));
    });
  }

  for (const invalid of [['--site-title'], ['--site-title='], ['--site-title', '--no-theme']]) {
    test(`${entry}：缺少标题值先报用法错误，不生成文件（${invalid.join(' ')}）`, (t) => {
      const f = fixture(t);
      const result = f.run(entry, [f.canonical, f.bundles, f.out, ...invalid]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--site-title/);
      assert.equal(existsSync(f.out), false);
    });
  }
}

test('site.js：--no-theme 保留原有的明确拒绝', (t) => {
  const f = fixture(t);
  const result = f.run('site.js', [f.canonical, f.bundles, f.out, '--no-theme']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--no-theme 与构建 HTML 冲突/);
  assert.equal(existsSync(f.out), false);
});

test('site.js：默认建站入口可成功执行', (t) => {
  const f = fixture(t);
  const result = f.run('site.js', [f.canonical, f.bundles, f.out]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.out, 'public/index.html')));
});

test('deploy.js：自定义标题用于预演，目的仓库保持原样', (t) => {
  const f = fixture(t);
  const repo = join(f.dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), '仓库原有文件');
  const stage = f.stage;
  for (const args of [
    [f.canonical, f.bundles, repo, '--dry-run', '--site-title=部署标题'],
    ['--site-title', '部署标题', f.canonical, f.bundles, repo, '--dry-run'],
  ]) {
    const result = f.run('deploy.js', args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(join(stage, 'hugo.toml'), 'utf-8').includes('title = "部署标题"'));
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf-8'), '仓库原有文件');
    assert.equal(existsSync(join(repo, 'index.html')), false, '预演不能部署');
  }
});
