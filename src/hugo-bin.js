/**
 * 找到（必要时下载）一个 Hugo 可执行文件。
 *
 * ## 为什么不写进 `dependencies`
 *
 * 因为那会把这个仓库的依赖数从 0 变成几百个。npm 上那些 `hugo-bin` 之类的包做的
 * 恰好就是这件事——下载官方二进制——只是外面裹了一层依赖树。而这个项目的整个论点
 * 是可审计与长命：**一个要装几百个包才能重建的存档站是自相矛盾的。**
 *
 * 所以这里自己下，四十行，零依赖：
 *
 *   1. 版本**钉死**在 `HUGO_VERSION`。不取 latest——存档站要能在几年后逐字节重建，
 *      而 latest 意味着同一份档案在不同时间会生成出不同的站点。
 *   2. SHA-256 **写在这个文件里**，不是下载下来之后再从同一个地方取校验和
 *      （那只是「信任第一次」，证明不了什么）。写在仓库里的值任何人都能自己核。
 *   3. 解压不调 `tar`，自己读——tar 就是 512 字节的头加内容，比处理各平台
 *      shell 差异简单。
 *
 * ## 只对 Linux 自动下载
 *
 * Hugo 0.164 的 macOS 只发 `.pkg`，没有 tarball；Windows 发 `.zip`。这两个平台
 * 就用 PATH 上现成的 hugo（`brew install hugo` / `winget install Hugo.Hugo`）。
 * **宁可让用户自己装，也不去解 pkg。**
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * 钉死的版本。
 *
 * 升级它的时候**必须**同时换掉下面的校验和——两者不同步的话下载会失败，
 * 而那正是想要的：宁可响亮地坏掉，也不要静悄悄地装上一个没核对过的二进制。
 */
export const HUGO_VERSION = '0.164.0';

/**
 * 官方发布的 SHA-256，取自 `hugo_<版本>_checksums.txt`。
 *
 * 自己核一遍：
 *
 *     curl -sSfL https://github.com/gohugoio/hugo/releases/download/v0.164.0/hugo_0.164.0_checksums.txt
 */
export const HUGO_SHA256 = {
  'linux-amd64': 'd9c8b17285ea4ec004d9f814273ea910f2051ce02c284993fd1f91ba455ae50d',
  'linux-arm64': '948ee5f0ed30175f31937d592d63a2712f0761a69f1cbe812f780eb918a08b8e',
  'linux-arm': '1a746adb5d599393571e97bc34ac5ae203b9a787f88c4216d282572ec2111261',
};

/** Node 的平台名 → Hugo 发布件的平台名。认不出来就返回 null，**不猜**。 */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux') return null;
  return { x64: 'linux-amd64', arm64: 'linux-arm64', arm: 'linux-arm' }[arch] ?? null;
}

/**
 * 从 tar 字节流里取出一个文件。
 *
 * 只认普通文件（typeflag `0`/`\0`）与 GNU 长名扩展不管——Hugo 的包里就三个文件，
 * 名字都很短。**认不出的条目直接跳过，不猜。**
 *
 * @param {Buffer} buf 已经解过 gzip 的 tar
 * @param {string} want 要取的文件名
 * @returns {Buffer|null}
 */
export function untarOne(buf, want) {
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.subarray(off, off + 100).toString('utf-8').replace(/\0.*$/, '');
    if (!name) { off += 512; continue; }
    const sizeField = buf.subarray(off + 124, off + 136).toString('utf-8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size)) return null;
    const type = String.fromCharCode(buf[off + 156]);
    const body = off + 512;
    if (name === want && (type === '0' || type === '\0')) return buf.subarray(body, body + size);
    // 内容按 512 对齐补零。
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * 找一个能用的 hugo。
 *
 * 顺序：缓存目录 → PATH → 下载。**PATH 排在下载前面**——用户自己装的那个是他
 * 选的，不该被我们悄悄换掉。
 *
 * @param {object} [opts]
 * @param {string} [opts.cacheDir] 下载到哪儿
 * @param {boolean} [opts.allowDownload] 允许联网下载，默认 true
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{path: string, source: 'cache'|'path'|'download'}>}
 */
export async function ensureHugo({ cacheDir, allowDownload = true, log = () => {} } = {}) {
  const dir = cacheDir ?? join(process.cwd(), '.hugo');
  const cached = join(dir, `hugo-${HUGO_VERSION}`);
  if (existsSync(cached)) return { path: cached, source: 'cache' };

  // PATH 上有就用 PATH 上的。
  try {
    const out = execFileSync('hugo', ['version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (/^hugo v/.test(out)) {
      log(`用 PATH 上的 hugo：${out.split(' ')[1]}`);
      return { path: 'hugo', source: 'path' };
    }
  } catch { /* 没装，继续 */ }

  const key = platformKey();
  if (!key) {
    throw new Error(
      `这个平台（${process.platform}/${process.arch}）没有可以直接下载的 Hugo 包，`
      + '请自己装一个再重试：macOS 用 `brew install hugo`，Windows 用 `winget install Hugo.Hugo`。',
    );
  }
  if (!allowDownload) throw new Error('本地没有 hugo，而这次不允许下载。');

  const file = `hugo_${HUGO_VERSION}_${key}.tar.gz`;
  const url = `https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/${file}`;
  log(`下载 Hugo ${HUGO_VERSION}（${key}）…`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  const tgz = Buffer.from(await res.arrayBuffer());

  const got = createHash('sha256').update(tgz).digest('hex');
  const want = HUGO_SHA256[key];
  if (got !== want) {
    // **响亮地坏掉。** 校验和对不上意味着拿到的不是我们钉死的那个二进制，
    // 而这东西是要在用户机器上执行的。
    throw new Error(`校验和不符。\n  期望 ${want}\n  实际 ${got}\n  来源 ${url}`);
  }

  const bin = untarOne(gunzipSync(tgz), 'hugo');
  if (!bin) throw new Error(`${file} 里没找到 hugo 可执行文件`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(cached, bin);
  chmodSync(cached, 0o755);
  log(`装好了：${cached}`);
  return { path: cached, source: 'download' };
}

/** 读回缓存里那个二进制的摘要，用来自查。 */
export function digestOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
