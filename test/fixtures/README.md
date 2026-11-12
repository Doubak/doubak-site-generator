# 头像夹具

合成的 16×8 蓝色栅格，不含真人数据。PNG 用 Python 标准库构造 RGBA / zlib / CRC；
JPEG、WebP 用 ImageMagick 从该 PNG 转换，GIF 是蓝色首帧 + 红色第二帧。
测试只读已提交字节，不依赖 ImageMagick。用于 MIME、格式解码、透明补边、不放大与首帧验证。

`avatar-square.png` 为 Python 标准库生成的 64×64 RGBA 合成图：左半部浅灰
`#f0f0f0`，右半部深灰 `#181818`。用于真实 Hugo 的头像缩小、角标与深色背景对比、
缓存重建和账号切换回归，不含真人数据。

`avatar-alpha.png` 为 Python 标准库生成的 32×32 RGBA 合成图：RGB 固定为
`(40,120,200)`，从左到右每 8 列分别使用 alpha 0、64、128、255。
用于验证透明／半透明头像在缩放、补边与叠加角标后没有被铺成白底；零 alpha 区域的隐藏 RGB 不参与视觉比较。
