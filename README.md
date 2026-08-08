# doubak-site-generator

豆备 (Doubak) 的静态网页生成器。把 [canonical](https://github.com/Doubak/doubak-data-specs) 数据转成 **Markdown + YAML front matter**，交给现成的静态站生成器渲染 —— 就像浏览自己开的豆瓣一样。

```sh
node bin/generate.js <canonical 目录> <bundle 目录> [产出目录] [--no-theme]
npm test    # node --test，零依赖，不需要 npm install
```

需要 Node ≥ 20。

## 从档案到能看的站点

```sh
# 1. 抓取产出的一堆 bundle → canonical
cd doubak-data-parser
node bin/parse.js ~/downloads/20260806 ~/downloads/20260806-canonical

# 2. canonical + bundle → 静态站源目录
cd ../doubak-site-generator
node bin/generate.js ~/downloads/20260806-canonical ~/downloads/20260806 ~/downloads/20260806-site
```

第二步为什么还要 bundle：canonical 是纯文本（用 `jq` 就能查，不装二进制），**图片的字节在 bundle 里**。两个输入一个都不能少。

产出：

```
20260806-site/
├── content/
│   ├── _index.md          首页：各媒介各状态的条数
│   ├── movie/ book/ music/ game/ drama/   一个作品一页，文件名是作品 id
│   ├── note/ review/      日记与评论全文
│   └── broadcast/         按月归档，2014-01.md … 2026-08.md
├── static/
│   ├── covers/            作品封面
│   └── uploads/           自己上传的图（广播附图、日记内嵌图）
├── hugo.toml              ↓ 这两个是自带的最小 Hugo 骨架，--no-theme 可以不要
└── layouts/
```

## 直接就能看：自带一个最小 Hugo 骨架

生成器**默认**会把 `theme/hugo/` 一并拷进产出目录，所以产出的就是一个能直接跑的 Hugo 站点：

```sh
node bin/generate.js ~/downloads/20260806-canonical ~/downloads/20260806 ~/downloads/20260806-site
cd ~/downloads/20260806-site && hugo server
```

```
20260806-site/
├── hugo.toml        ← 骨架
├── layouts/         ← 骨架
├── content/         ← 生成的
└── static/          ← 生成的
```

选 Hugo 是因为它是**单个二进制**，没有依赖树 —— 这份东西的整个论点是可审计与长命，而一个要装几百个 npm 包才能重建的存档站是自相矛盾的。另外 `content/` + `static/` 这个布局本来就是 Hugo 的，少一层适配。

骨架**不发任何外部请求**：样式内联、字体用系统栈、没有统计脚本、没有评论服务。这份备份存在的理由是不再需要豆瓣还活着才能看，那它自己也不该需要某个 CDN 还活着才好看。

### 骨架是起点，不是产品

它刻意只有五个文件，**就是为了让你删掉它**：

```sh
node bin/generate.js <canonical> <bundles> <out> --no-theme    # 只出 content/ 与 static/
```

换成任何一个现成的 Hugo 主题：删掉 `layouts/`，照那个主题的说明配置，**`content/` 与 `static/` 一个字都不用动**。换成 Astro / Eleventy / Jekyll 也一样，只是目录名不同（Astro 是 `src/content/` 与 `public/`，Jekyll 是 `_posts/` 与站点根）。

这正是「不做模板引擎」那条的兑现方式 —— 产出的是 Markdown + YAML front matter 这种**所有 SSG 都吃的东西**，于是每一个现成的主题生态都变成模板库。自己写一个模板引擎意味着要重新发明布局、分页、RSS、搜索，而那些早就有人做得更好。

front matter 里除了 `title` / `date` / `tags` 全部带 `douban_` 前缀，就是为了不撞上主题自己的约定。主题认不认得它们不影响构建，只是不显示：

| 键 | 出现在 |
|---|---|
| `douban_kind` | 全部。取值 `mark` / `note` / `review` / `broadcast_month` / `index` |
| `douban_medium` `douban_status` `douban_verb` `douban_rating` `douban_cover` `douban_meta` `douban_upstream_deleted` | 标记 |
| `douban_published_at_raw` `douban_location` `douban_subject_url` | 日记与评论 |
| `douban_month` `douban_count` `douban_with_text` `douban_images` | 广播月页 |
| `douban_revisions` `douban_last_seen` `douban_url` | 全部 —— 通往 canonical 的线索 |

`test/pages.test.js` 里有一条测试专门守着这张表：**骨架模板引用的每个 `douban_*` 键，生成器都真的会写。** 这两边是靠字符串对上的，拼错一个字不会报错 —— Hugo 对不存在的 `.Params.x` 返回空值，页面照样渲染，只是那一块永远是空的。

### 还没验证过的那一环

**没有对着 Hugo 真的构建过。** 3098 个文件里只要有一处 front matter 不合它的口味，整站构建就会失败。目前的证据都是间接的：

- `test/yaml.test.js` 拿冒号、引号、井号、颜文字、看起来像布尔值的 `no`、看起来像数字的 `007` 做往返验证
- 生成那 3098 个文件之后，用一个独立写的读取器把每一份 front matter 都读了回来，无一读不动
- 骨架模板引用的键与生成器写的键对得上（上面那条测试）

**这三条都不等于「Hugo 能构建」。** 最可疑的是 8 个 `date: null` 的页面（上游被删、没有标记时间的那几条）—— 真去验的话，先看它们。

## 两个输入，一个都不能少

| | 提供什么 |
|---|---|
| canonical | 有什么：标记、作品、长文、广播 |
| bundle | 图片的字节 —— canonical 是文本，用 `jq` 就能查，不装二进制 |

**整个过程零网络请求。** 站点也是派生数据，那条不变量在这里同样成立：丢掉产出目录、只靠档案重建，必须能离线跑通。

## 图片一定要导出

不导出的话，站点里每张图都是一个指向 `doubanio.com` 的 URL —— **这份备份要联网才能看，而且要豆瓣还在才能看。** 那正是这个项目存在的理由所要否定的东西。前代工具的备份就卡在这一点上。

封面要**按作品 id 找，不能只按 URL 找**。canonical 里的 `cover_url` 取自列表页缩略图，档案里存的却是详情页封面 —— 多数媒介两者恰好同一个文件，舞台剧那种不是（`…/small/…` vs `…/m/…`）。只按 URL 找会漏掉实测 95 张**明明就在档案里**的图，而且漏的是本来就少的媒介，肉眼几乎发现不了。

豆瓣的「暂无封面」占位图当成没有封面。与「上游被删时作品名保持 null」是同一条规则：**占位符不是内容**。原样带过去的话，一份号称离线可看的备份会为了一张本来就不存在的图去联网。

档案里没有的图会在跑完时列出来，不静默忽略：页面上缺一张图，用户该知道为什么。但**告警要么是真的、要么就不该出现** —— 已经按作品 id 找到的、以及占位图，都不算缺。一条永远在的假告警会让真的那条也被忽略。

## 投影是只读缓存

CLAUDE.md 里的硬性规则：**用户的编辑追加到 canonical，任何东西都不写投影。** 投影一旦可写，就有了两个真相来源，「无摩擦导出」这个承诺随即作废。

所以产出目录**每次生成都先清空**。不清的话，上次生成、这次已经不该存在的页面会留下来 —— 那种「幽灵页面」在静态站里格外难发现：有固定链接、能打开、内容看着也正常，只是早就不在数据里了。

## 几条不会报错、但会让站点说假话的规则

- **上游被删的作品，名字保持 `null`。** 页面上那句「未知电影」是豆瓣的占位符，不是名字；填进去它会一路传到页面标题、外部检索、导出文件里。
- **没有短评就是空正文**，不编一句「暂无短评」—— 那会让「没写」和「写了但抓不到」在页面上长得一样。
- **元信息（导演、演员那一串）原样带过去，不在这一层拆。** 实测电影 2090 条里出现过 43 种段数，按位置拆多数行都错；按内容猜属于 enricher，它的产出带 `source` 与置信度、可以重跑。
- **首页只给数字，不给百分比，也不写「完整」。** 完整性的证据在 bundle 的 `crawl_state` 里，投影没有资格复述一个可能过期的结论。
- **文件名用作品 id 不用标题。** 标题会变、可能是 null、还可能撞名；id 稳定，固定链接才不会在重新生成之后全变。

## 广播按月归档，不是一条一页

3394 条广播里只有 804 条带正文，其余是纯标记动作（「想看 X」）。一条一页会产出三千多个只有一行字的文件，把真正有内容的那八百条埋掉。按月归档保留了广播本来的形状 —— **它是一条时间线，不是一堆条目**。

固定链接不丢：每条都有自己的时间戳小标题，SSG 会给它生成锚点。月内倒序，与豆瓣一致，也与抓取方向一致。

广播里的作品链接**只接本地页面**。接不回来（作品没被标记过、或者 id 撞车）就只留文字，不回退到豆瓣的 URL。id 撞车时一律不接 —— 广播上只有 `data-object-id`，没有媒介，接错了是档案在说假话，而且看不出来。

## 现状

标记、作品、长文、广播都做了。对着八份成链的真实档案：

```
页面 3098（标记 2940 · 长文 5 · 广播 3394 条归入 152 个月）
图片 3045 张（封面 2921 + 自己上传的 124）
3.2 秒 · 128 MB
全站指向 doubanio.com 的引用：0
```

最后一行是这里唯一真正要守的数字。**它一旦不是 0，这份备份就又需要豆瓣还在才能看了** —— 而那正是这个项目存在的理由所要否定的东西。
