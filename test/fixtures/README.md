# 头像夹具

合成的 16×8 蓝色栅格，不含真人数据。PNG 用 Python 标准库构造 RGBA / zlib / CRC；
JPEG、WebP 用 ImageMagick 从该 PNG 转换，GIF 是蓝色首帧 + 红色第二帧。
测试只读已提交字节，不依赖 ImageMagick。用于 MIME、格式解码、透明补边、不放大与首帧验证。
