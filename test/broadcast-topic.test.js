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
