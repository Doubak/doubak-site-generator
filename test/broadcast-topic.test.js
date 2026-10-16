import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/projection.js';
import { broadcastBlock } from '../src/markdown.js';
import { buildSearchIndex } from '../src/search.js';

test('topic 标题从 canonical 到正文与搜索；原页去跟踪参数，时间锚点不变', () => {
  const p = project({ broadcasts: [{ upstream_id: '9001', account: { user_id: '111' },
    url: 'https://www.douban.com/topic/7001/?_spm_id=example',
    revisions: [{ fields: { title: '标题 *与* 留存', text: '正文', action: '说', visibility: 'public',
      posted_at: { raw: '2026-10-15 21:48:00', iso: '2026-10-15T21:48:00+08:00' } } }],
  }] });
  const b = p.broadcasts[0];
  assert.equal(b.title, '标题 *与* 留存');
  assert.equal(b.url, 'https://www.douban.com/topic/7001/');
  const md = broadcastBlock(b);
  assert.ok(md.startsWith('### 2026-10-15 21:48:00\n'));
  assert.ok(md.includes(String.raw`**标题 \*与\* 留存**`));
  assert.ok(md.includes('正文'));
  assert.equal(buildSearchIndex(p).rows[0].n, b.title);
  b.text = null;
  assert.equal(buildSearchIndex(p).rows.length, 1, '只有标题仍能搜到');
  delete b.title;
  assert.equal(buildSearchIndex(p).rows.length, 0, '旧无标题纯标记仍跳过');
});

test('广播正文链接投影与渲染：外链加 external，站内链到文件', () => {
  const p = project({
    subjects: [{ medium: 'game', id: '30246116' }],
    broadcasts: [{ upstream_id: '9871051745', account: { user_id: '82160871' },
      url: 'https://www.douban.com/topic/502623668/',
      revisions: [{ fields: {
        title: '闲逛豆瓣有感',
        text: '备份豆瓣的意义吧～ 开发日志\n@豆友69305634，顺便玩了 寂静之人',
        text_parts: [
          { text: '备份豆瓣的意义吧～ ' },
          { text: '开发日志', url: 'https://doubak.com/log/example.html' },
          { text: '\n@' },
          { text: '豆友69305634', url: 'https://www.douban.com/people/69305634/' },
          { text: '，顺便玩了 ' },
          { text: '寂静之人', url: 'https://www.douban.com/game/30246116/' },
        ],
        action: '说', visibility: 'public',
        posted_at: { raw: '2026-10-15 21:48:00', iso: '2026-10-15T21:48:00+08:00' },
      } }],
    }],
  });
  const b = p.broadcasts[0];
  assert.equal(b.textParts.length, 6);
  assert.deepEqual(b.textParts[1], { text: '开发日志', href: 'https://doubak.com/log/example.html', external: true });
  assert.deepEqual(b.textParts[3], { text: '豆友69305634', href: 'https://www.douban.com/people/69305634/', external: true });
  assert.deepEqual(b.textParts[5], { text: '寂静之人', href: 'game/30246116.md' });

  // 首页渲染（linkPrefix: ''）
  const mdIndex = broadcastBlock(b, { linkPrefix: '' });
  assert.ok(mdIndex.includes('[开发日志](https://doubak.com/log/example.html)'));
  assert.ok(mdIndex.includes('@[豆友69305634](https://www.douban.com/people/69305634/)'));
  assert.ok(mdIndex.includes('[寂静之人](game/30246116.md)'));

  // 月度页渲染（linkPrefix: '../'）
  const mdMonth = broadcastBlock(b, { linkPrefix: '../' });
  assert.ok(mdMonth.includes('[开发日志](https://doubak.com/log/example.html)'));
  assert.ok(mdMonth.includes('@[豆友69305634](https://www.douban.com/people/69305634/)'));
  assert.ok(mdMonth.includes('[寂静之人](../game/30246116.md)'));

  // textParts 为空数组或 null 时正常回退至普通文本
  b.textParts = [];
  assert.ok(broadcastBlock(b).includes('备份豆瓣的意义吧～ 开发日志\n@豆友69305634，顺便玩了 寂静之人'));
  b.textParts = null;
  assert.ok(broadcastBlock(b).includes('备份豆瓣的意义吧～ 开发日志\n@豆友69305634，顺便玩了 寂静之人'));

  // 链接文本含 Markdown 标点符号时正确转义
  b.textParts = [{ text: '点我：' }, { text: ' Fate/stay [Heaven] ', href: 'https://example.com', external: true }];
  const mdEscaped = broadcastBlock(b);
  assert.ok(mdEscaped.includes(String.raw`[Fate/stay \[Heaven\]](https://example.com)`));
});


