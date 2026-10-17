/** Small independent decoder for the non-interlaced PNGs emitted by our Hugo fixtures.
 * Only used as a pixel oracle: production image decoding remains Hugo's job.
 */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export function pngPixels(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const depth = bytes[24], type = bytes[25];
  assert.equal(bytes[28], 0, 'fixture output must not be interlaced');
  const channels = { 2: 3, 3: 1, 6: 4 }[type];
  assert.ok(channels, `unexpected PNG color type ${type}`);
  const chunks = [], colors = [], alpha = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IDAT') chunks.push(data);
    if (kind === 'PLTE') colors.push(...data);
    if (kind === 'tRNS') alpha.push(...data);
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = Math.ceil(width * channels * depth / 8), bpp = Math.ceil(channels * depth / 8);
  const decoded = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const pos = y * stride + x;
      const a = x >= bpp ? decoded[pos - bpp] : 0;
      const b = y ? decoded[pos - stride] : 0;
      const c = y && x >= bpp ? decoded[pos - stride - bpp] : 0;
      decoded[pos] = raw[y * (stride + 1) + x + 1] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
    }
  }
  const pixels = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (type === 3) {
      const bit = x * depth, index = (decoded[y * stride + (bit >> 3)] >> (8 - depth - bit % 8)) & ((1 << depth) - 1);
      pixels.push([...colors.slice(index * 3, index * 3 + 3), alpha[index] ?? 255]);
    } else {
      assert.equal(depth, 8);
      const pos = y * stride + x * channels;
      pixels.push([...decoded.subarray(pos, pos + 3), type === 6 ? decoded[pos + 3] : 255]);
    }
  }
  return { width, height, pixels };
}
