# favicon 角标素材

`doubak-favicon-badge.svg` 取自豆备现有标志的前景豆子几何、−20° 倾角、
绿色 `#2E963D` 与米色 `#FFF4D8`，加白边以区分深浅头像背景。
原标志见 [doubak-website 的小尺寸 SVG](https://github.com/Doubak/doubak-website/blob/main/assets/logos/doubak-icon-small.svg)。
只用一颗豆子，避免在角标尺寸下挤入双豆细节。

运行时使用已提交的 `theme/hugo/assets/branding/doubak-badge-{8,16}.png`；
构建站点和跑测试均不需要 SVG 栅格化工具，也不会联网取标志。
两个尺寸分别叠到 16×16、32×32 favicon 的右下四分之一区域。
头像原图、touch icon 和页眉图不加角标。

修改矢量源后可用 ImageMagick 重新生成（当前文件用 6.9.11-60 生成）：

```sh
convert -background none -density 384 tools/assets/doubak-favicon-badge.svg \
  -resize 16x16 -strip PNG32:theme/hugo/assets/branding/doubak-badge-16.png
convert -background none -density 384 tools/assets/doubak-favicon-badge.svg \
  -resize 8x8 -strip PNG32:theme/hugo/assets/branding/doubak-badge-8.png
node --test test/avatar-hugo.test.js
```

图片合成使用 Hugo 原生 [images.Overlay](https://gohugo.io/functions/images/overlay/)，
在缩小和透明补边之后执行。分别合成两个分辨率，避免浏览器只能把带角标的 32px 图片缩成 16px。
派生资源路径由 Hugo 内容处理缓存生成，头像或角标变化会产生新的图标资源。
测试使用锁定版本的真实 Hugo，并独立读取 PNG 像素核对区域、透明度、品牌颜色与缓存重建。
