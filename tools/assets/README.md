# favicon 角标素材

角标使用与 [doubak-website 官网标志](https://github.com/Doubak/doubak-website/tree/main/assets/logos) 同源的双豆几何、−20° 倾角、品牌绿 `#2E963D` 与豆色 `#FFF4D8`；外沿和圆角透明，全幅铺满且 `rx = 25%`，不添加白色底板。

对应关系见原仓库 `gen_logo.py` 的分档原则：

| 文件 | 角标边长 | 距右侧／底侧 | 角标占边长 | 光学档位 |
|---|---:|---:|---:|---|
| `doubak-badge-8.png` | 8px | 0px | 50% | micro：省略亚像素前豆脐并略扩分隔缝，保留清晰双豆轮廓 |
| `doubak-badge-12.png` | 12px | 1px | 37.5% | small（同 `doubak-favicon-badge-small.svg` / 官网 `doubak-icon-small.svg`）：仅前豆带豆脐 |
| `doubak-badge-36.png` | 36px | 12px | 20% | mid（同 `doubak-favicon-badge.svg` / 官网 `doubak-icon-mid.svg`）：双豆均带豆脐；不放「豆」字，避免 < 128px 笔划糊化 |

运行时使用已提交的 `theme/hugo/assets/branding/doubak-badge-{8,12,36}.png`；构建站点和跑测试均不需要额外 SVG 栅格化工具，也不会联网取标志。

大图参考手游图标中让主体占据画面、品牌标记缩小的处理方式，比例是本项目的视觉选择，不是平台强制标准。touch icon 居中裁切、允许放大并铺满画布，避免小头像补边造成白圈；角标内缩以避开系统的圆角裁切。头像原图和页眉图不加角标。

## 为什么不用 `convert` / `cairosvg` 从 SVG 现转

官网母版 SVG 定义了两个 `<mask>`：ImageMagick 的内建 MSVG 渲染器与 `cairosvg` 都会静默忽略或破坏多 `<mask>` 文档（产出发白／不透明圆角或糊化黑边），而 `-resize 8x8` 也会让小图发虚。因此本仓库提供零依赖的纯 Node 16×16 亚像素超采样脚本，按 `gen_logo.py` 完全一致的 Bézier 几何生成并校验三个 PNG：

```sh
node tools/assets/generate-badges.mjs
node tools/assets/generate-badges.mjs --check
node --test test/avatar-hugo.test.js
```

图片合成使用 Hugo 原生 [images.Overlay](https://gohugo.io/functions/images/overlay/)，在头像缩放／补边／裁切之后执行。分别合成各个分辨率，避免浏览器只能把带角标的 32px 图片缩成 16px。派生资源路径由 Hugo 内容处理缓存生成，头像或角标变化会产生新的图标资源。测试使用锁定版本的真实 Hugo，并独立读取 8／16-bit PNG 像素核对区域、透明度、品牌颜色、双豆分瓣与缓存重建。`avatar-alpha.png` 专门覆盖 0、64、128、255 四档 alpha；不能用本身不透明的 JPEG 来判断 alpha 是否丢失。
