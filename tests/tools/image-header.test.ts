import { describe, expect, it } from "vitest";
import {
  estimateImageTokens,
  IMAGE_TOKENS_FALLBACK,
  IMAGE_TOKENS_MAX,
  IMAGE_TOKENS_MIN,
  parseImageHeader,
  parseImageHeaderBase64,
} from "../../src/tools/image-header.js";

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); // IHDR length
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegBytes(width: number, height: number, options: { sof?: number; exifBytes?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (options.exifBytes !== undefined) {
    const segment = Buffer.alloc(4 + options.exifBytes);
    segment.writeUInt16BE(0xffe1, 0);
    segment.writeUInt16BE(2 + options.exifBytes, 2);
    parts.push(segment);
  }
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xff00 | (options.sof ?? 0xc0), 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  parts.push(sof);
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])); // SOS + EOI
  return Buffer.concat(parts);
}

function webpChunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(12 + data.length, 4);
  header.write("WEBP", 8, "ascii");
  header.write(fourcc, 12, "ascii");
  header.writeUInt32LE(data.length, 16);
  return Buffer.concat([header, data]);
}

function webpLossy(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[3] = 0x9d;
  data[4] = 0x01;
  data[5] = 0x2a;
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", data);
}

function webpLossless(width: number, height: number): Buffer {
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(packed >>> 0, 1);
  return webpChunk("VP8L", data);
}

function webpExtended(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", data);
}

describe("parseImageHeader", () => {
  it("PNG IHDR 宽高（BE32）", () => {
    expect(parseImageHeader(pngBytes(1920, 1080))).toEqual({
      mimeType: "image/png",
      width: 1920,
      height: 1080,
    });
  });

  it("JPEG baseline 与 progressive SOF", () => {
    for (const sof of [0xc0, 0xc1, 0xc2]) {
      expect(parseImageHeader(jpegBytes(640, 480, { sof }))).toEqual({
        mimeType: "image/jpeg",
        width: 640,
        height: 480,
      });
    }
  });

  it("JPEG EXIF 前置段后仍能定位 SOF", () => {
    expect(parseImageHeader(jpegBytes(800, 600, { exifBytes: 4096 }))).toEqual({
      mimeType: "image/jpeg",
      width: 800,
      height: 600,
    });
  });

  it("WEBP VP8 / VP8L / VP8X 三种 chunk", () => {
    for (const bytes of [webpLossy(320, 200), webpLossless(320, 200), webpExtended(320, 200)]) {
      expect(parseImageHeader(bytes)).toEqual({ mimeType: "image/webp", width: 320, height: 200 });
    }
  });

  it("VP8 宽高忽略高 2 位 scale", () => {
    const bytes = webpLossy(320, 200);
    bytes.writeUInt16LE(320 | 0x8000, 26);
    bytes.writeUInt16LE(200 | 0x4000, 28);
    expect(parseImageHeader(bytes)).toEqual({ mimeType: "image/webp", width: 320, height: 200 });
  });

  it("损坏/截断/未知格式返回 null", () => {
    const fixtures = [
      Buffer.alloc(0),
      Buffer.from("GIF89a"),
      pngBytes(1920, 1080).subarray(0, 20), // IHDR 截断
      jpegBytes(640, 480).subarray(0, 8), // SOF 前截断
      webpLossy(320, 200).subarray(0, 25), // sync code 截断
      Buffer.from("RIFF0000WEBPXXXX"),
      jpegBytes(0, 480),
      pngBytes(0, 1080),
    ];
    for (const bytes of fixtures) expect(parseImageHeader(bytes)).toBeNull();
    // JPEG 遇 SOS 仍无 SOF → null
    const noSof = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
    expect(parseImageHeader(noSof)).toBeNull();
  });
});

describe("parseImageHeaderBase64", () => {
  it("从 base64 前缀解析头部", () => {
    const data = jpegBytes(1024, 768).toString("base64");
    expect(parseImageHeaderBase64(data)).toEqual({ mimeType: "image/jpeg", width: 1024, height: 768 });
  });

  it("SOF 超出前缀预算时返回 null（估算侧回退）", () => {
    const data = jpegBytes(1024, 768, { exifBytes: 4096 }).toString("base64");
    expect(parseImageHeaderBase64(data, 64)).toBeNull();
    expect(parseImageHeaderBase64(data)).toEqual({ mimeType: "image/jpeg", width: 1024, height: 768 });
  });

  it("非法 base64 返回 null", () => {
    expect(parseImageHeaderBase64("")).toBeNull();
    expect(parseImageHeaderBase64("not an image")).toBeNull();
  });
});

describe("estimateImageTokens", () => {
  it("公式 ceil(w*h/750)", () => {
    expect(estimateImageTokens(pngBytes(1920, 1080).toString("base64"))).toBe(2765);
    expect(estimateImageTokens(webpLossless(750, 750).toString("base64"))).toBe(750);
  });

  it("钳位 [256, 16384]", () => {
    expect(estimateImageTokens(pngBytes(1, 1).toString("base64"))).toBe(IMAGE_TOKENS_MIN);
    expect(estimateImageTokens(webpExtended(16384, 16384).toString("base64"))).toBe(IMAGE_TOKENS_MAX);
  });

  it("解析失败回退 4096", () => {
    expect(estimateImageTokens("")).toBe(IMAGE_TOKENS_FALLBACK);
    expect(estimateImageTokens(Buffer.from("garbage").toString("base64"))).toBe(IMAGE_TOKENS_FALLBACK);
  });

  it("重复调用与超过缓存容量后结果稳定（FIFO 淘汰不改变语义）", () => {
    const data = pngBytes(640, 480).toString("base64");
    expect(estimateImageTokens(data)).toBe(410);
    for (let index = 0; index < 200; index += 1) {
      estimateImageTokens(pngBytes(index + 1, 100).toString("base64"));
    }
    expect(estimateImageTokens(data)).toBe(410);
  });
});