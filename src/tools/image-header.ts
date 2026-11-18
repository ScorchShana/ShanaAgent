import type { ImageMimeType } from "../sessions/records.js";

export interface ImageHeader {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

export const IMAGE_TOKENS_MIN = 256;
export const IMAGE_TOKENS_MAX = 16_384;
export const IMAGE_TOKENS_FALLBACK = 4096;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parsePng(bytes: Uint8Array): ImageHeader | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 24 || !view.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (view.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { mimeType: "image/png", width, height };
}

// SOF0–3/5–7/9–11 携带尺寸（baseline/extended/progressive 及算术编码变体）。
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb]);

function parseJpeg(bytes: Uint8Array): ImageHeader | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < view.length) {
    // marker 前允许任意数量 fill 字节 0xFF。
    while (offset < view.length && view[offset] === 0xff) offset += 1;
    if (offset >= view.length) return null;
    const marker = view[offset]!;
    offset += 1;
    // 无负载 marker：TEM/RSTn/SOI/EOI；遇 SOS/EOI 后不再有 SOF。
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > view.length) return null;
    const segmentLength = view.readUInt16BE(offset);
    if (segmentLength < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      // 段布局：length(2) precision(1) height(2) width(2)
      if (offset + 7 > view.length || segmentLength < 7) return null;
      const height = view.readUInt16BE(offset + 3);
      const width = view.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { mimeType: "image/jpeg", width, height };
    }
    offset += segmentLength;
  }
  return null;
}

function parseWebp(bytes: Uint8Array): ImageHeader | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.length < 16 ||
    view.toString("ascii", 0, 4) !== "RIFF" ||
    view.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = view.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // 有损关键帧：3 字节 frame tag + sync code 9D 01 2A + LE16 宽高（高 2 位是 scale）。
    if (view.length < 30) return null;
    if (view[23] !== 0x9d || view[24] !== 0x01 || view[25] !== 0x2a) return null;
    const width = view.readUInt16LE(26) & 0x3fff;
    const height = view.readUInt16LE(28) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { mimeType: "image/webp", width, height };
  }
  if (chunk === "VP8L") {
    // 无损：signature 0x2F 后 14bit width-1 + 14bit height-1 打包于 LE32。
    if (view.length < 25 || view[20] !== 0x2f) return null;
    const packed = view.readUInt32LE(21);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >> 14) & 0x3fff) + 1;
    return { mimeType: "image/webp", width, height };
  }
  if (chunk === "VP8X") {
    // 扩展格式：canvas 宽高各为 LE24 的 (值-1)，位于 chunk 数据 offset 4/7。
    if (view.length < 30) return null;
    const width = view.readUIntLE(24, 3) + 1;
    const height = view.readUIntLE(27, 3) + 1;
    return { mimeType: "image/webp", width, height };
  }
  return null;
}

export function parseImageHeader(bytes: Uint8Array): ImageHeader | null {
  return parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
}

// 消息 image 块只有 base64 无宽高；解析只需头部，前缀截断避免解码整图。
const DEFAULT_BASE64_PREFIX_CHARS = 1_048_576;

export function parseImageHeaderBase64(
  data: string,
  maxBase64Chars: number = DEFAULT_BASE64_PREFIX_CHARS,
): ImageHeader | null {
  const prefix = data.slice(0, maxBase64Chars - (maxBase64Chars % 4));
  try {
    return parseImageHeader(Buffer.from(prefix, "base64"));
  } catch {
    return null;
  }
}

// FIFO 上限仿框架 pngCache：估算在每次 buildContext 全量重跑，重复解码大图代价高。
const ESTIMATE_CACHE_MAX = 128;
const estimateCache = new Map<string, number>();

export function estimateImageTokens(base64Data: string): number {
  const cached = estimateCache.get(base64Data);
  if (cached !== undefined) return cached;
  const header = parseImageHeaderBase64(base64Data);
  const tokens = header
    ? Math.min(IMAGE_TOKENS_MAX, Math.max(IMAGE_TOKENS_MIN, Math.ceil((header.width * header.height) / 750)))
    : IMAGE_TOKENS_FALLBACK;
  if (estimateCache.size >= ESTIMATE_CACHE_MAX) {
    const oldest = estimateCache.keys().next().value;
    if (oldest !== undefined) estimateCache.delete(oldest);
  }
  estimateCache.set(base64Data, tokens);
  return tokens;
}