# favicon 角标素材

`doubak-favicon-badge.svg` 取自豆备现有标志的前景豆子几何、−20° 倾角、
绿色 `#2E963D` 与米色 `#FFF4D8`。外沿和圆角透明，不添加白色底板。
原标志见 [doubak-website 的小尺寸 SVG](https://github.com/Doubak/doubak-website/blob/main/assets/logos/doubak-icon-small.svg)。
只用一颗豆子，避免在角标尺寸下挤入双豆细节。

运行时使用已提交的 `theme/hugo/assets/branding/doubak-badge-{8,12,36}.png`；
构建站点和跑测试均不需要 SVG 栅格化工具，也不会联网取标志。
| 产物 | 角标边长 | 距右侧／底侧 | 角标占边长 |
|---|---:|---:|---:|
| 16×16 favicon | 8px | 0px | 50% |
| 32×32 favicon | 12px | 1px | 37.5% |
| 180×180 touch icon | 36px | 12px | 20% |

大图参考手游图标中让主体占据画面、品牌标记缩小的处理方式，比例是本项目的视觉选择，
不是平台强制标准。touch icon 居中裁切、允许放大并铺满画布，避免小头像补边造成白圈；
角标内缩以避开系统的圆角裁切。头像原图和页眉图不加角标。

修改矢量源后可用 ImageMagick 重新生成（当前文件用 6.9.11-60 生成）：

```sh
convert -background none -density 384 tools/assets/doubak-favicon-badge.svg \
  -resize 8x8 -strip PNG32:theme/hugo/assets/branding/doubak-badge-8.png
convert -background none -density 384 tools/assets/doubak-favicon-badge.svg \
  -resize 12x12 -strip PNG32:theme/hugo/assets/branding/doubak-badge-12.png
convert -background none -density 384 tools/assets/doubak-favicon-badge.svg \
  -resize 36x36 -strip PNG32:theme/hugo/assets/branding/doubak-badge-36.png
node --test test/avatar-hugo.test.js
```

图片合成使用 Hugo 原生 [images.Overlay](https://gohugo.io/functions/images/overlay/)，
在头像缩放／补边／裁切之后执行。分别合成各个分辨率，避免浏览器只能把带角标的 32px 图片缩成 16px。
派生资源路径由 Hugo 内容处理缓存生成，头像或角标变化会产生新的图标资源。
测试使用锁定版本的真实 Hugo，并独立读取 8／16-bit PNG 像素核对区域、透明度、品牌颜色与缓存重建。
`avatar-alpha.png` 专门覆盖 0、64、128、255 四档 alpha；不能用本身不透明的 JPEG 来判断 alpha 是否丢失。
