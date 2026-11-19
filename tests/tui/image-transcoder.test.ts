import { afterEach, expect, it, vi } from "vitest";

// Spy on sharp's default export while keeping the real native pipeline, so job
// spawns are countable without mocking away the actual conversion.
vi.mock("sharp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sharp")>();
  return { ...actual, default: vi.fn(actual.default) };
});
import sharp from "sharp";
import { onTranscodeReady, transcodeToPng } from "../../src/tui/image-transcoder.js";

const sharpSpy = vi.mocked(sharp);
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  sharpSpy.mockClear();
});

function nextReady(): Promise<void> {
  return new Promise((resolve) => {
    const off = onTranscodeReady(() => {
      off();
      resolve();
    });
    cleanups.push(off);
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Fixtures are synthesized on the fly; no binary assets enter the repository.
async function jpegFixture(
  width: number,
  height: number,
  background: { r: number; g: number; b: number },
  orientation?: number,
): Promise<string> {
  let pipeline = sharp({ create: { width, height, channels: 3, background } });
  if (orientation !== undefined) pipeline = pipeline.withMetadata({ orientation });
  return (await pipeline.jpeg().toBuffer()).toString("base64");
}

const pngMeta = (base64: string) => sharp(Buffer.from(base64, "base64")).metadata();

it("converts jpeg to a dimension-preserving PNG and caches the result", async () => {
  const data = await jpegFixture(8, 6, { r: 200, g: 30, b: 30 });
  sharpSpy.mockClear();
  const ready = nextReady();
  expect(transcodeToPng(data, "image/jpeg")).toBeNull();
  await ready;
  expect(sharpSpy).toHaveBeenCalledTimes(1);
  const png = transcodeToPng(data, "image/jpeg");
  expect(png).not.toBeNull();
  expect(sharpSpy).toHaveBeenCalledTimes(1); // cached lookup spawns nothing
  const meta = await pngMeta(png!);
  expect(meta.format).toBe("png");
  expect(meta.width).toBe(8);
  expect(meta.height).toBe(6);
});

it("applies EXIF orientation so PNG dimensions are rotated", async () => {
  const data = await jpegFixture(4, 2, { r: 10, g: 120, b: 200 }, 6);
  sharpSpy.mockClear();
  const ready = nextReady();
  transcodeToPng(data, "image/jpeg");
  await ready;
  const meta = await pngMeta(transcodeToPng(data, "image/jpeg")!);
  expect(meta.width).toBe(2);
  expect(meta.height).toBe(4);
});

it("preserves webp alpha and exact pixels through lossless roundtrip", async () => {
  const raw = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 0, 0]);
  const data = (
    await sharp(raw, { raw: { width: 2, height: 2, channels: 4 } })
      // exact: lossless webp otherwise zeroes RGB of fully transparent pixels.
      .webp({ lossless: true, exact: true })
      .toBuffer()
  ).toString("base64");
  sharpSpy.mockClear();
  const ready = nextReady();
  expect(transcodeToPng(data, "image/webp")).toBeNull();
  await ready;
  const png = transcodeToPng(data, "image/webp")!;
  const { data: pixels, info } = await sharp(Buffer.from(png, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(2);
  expect(info.height).toBe(2);
  expect(info.channels).toBe(4);
  expect(pixels.equals(raw)).toBe(true);
});

it("downscales long edges above 2048px and never enlarges", async () => {
  const big = await jpegFixture(3000, 100, { r: 1, g: 2, b: 3 });
  const small = await jpegFixture(4, 2, { r: 3, g: 2, b: 1 });
  sharpSpy.mockClear();
  const readyBig = nextReady();
  transcodeToPng(big, "image/jpeg");
  await readyBig;
  const readySmall = nextReady();
  transcodeToPng(small, "image/jpeg");
  await readySmall;
  const bigMeta = await pngMeta(transcodeToPng(big, "image/jpeg")!);
  expect(bigMeta.width).toBe(2048);
  expect(bigMeta.height).toBe(68);
  const smallMeta = await pngMeta(transcodeToPng(small, "image/jpeg")!);
  expect(smallMeta.width).toBe(4);
  expect(smallMeta.height).toBe(2);
});

it("negative-caches corrupt data without respawning jobs or notifying", async () => {
  const data = Buffer.from("definitely not a jpeg").toString("base64");
  let fired = 0;
  cleanups.push(
    onTranscodeReady(() => {
      fired += 1;
    }),
  );
  sharpSpy.mockClear();
  expect(transcodeToPng(data, "image/jpeg")).toBeNull();
  await delay(250);
  expect(transcodeToPng(data, "image/jpeg")).toBeNull();
  await delay(50);
  expect(sharpSpy).toHaveBeenCalledTimes(1);
  expect(fired).toBe(0);
});

it("ignores png and unsupported mime types without spawning jobs", async () => {
  const data = await jpegFixture(2, 2, { r: 9, g: 9, b: 9 });
  sharpSpy.mockClear();
  expect(transcodeToPng(data, "image/png")).toBeNull();
  expect(transcodeToPng(data, "image/gif")).toBeNull();
  await delay(30);
  expect(sharpSpy).not.toHaveBeenCalled();
});

it("deduplicates concurrent lookups into one job and one ready event", async () => {
  const data = await jpegFixture(6, 4, { r: 40, g: 80, b: 120 });
  let fired = 0;
  cleanups.push(
    onTranscodeReady(() => {
      fired += 1;
    }),
  );
  sharpSpy.mockClear();
  const ready = nextReady();
  expect(transcodeToPng(data, "image/jpeg")).toBeNull();
  expect(transcodeToPng(data, "image/jpeg")).toBeNull();
  await ready;
  await delay(50);
  expect(sharpSpy).toHaveBeenCalledTimes(1);
  expect(fired).toBe(1);
});

it("evicts the oldest finished entry beyond the cache limit", async () => {
  const keys: string[] = [];
  for (let i = 0; i < 40; i++) {
    // Vary width: tiny solid-color JPEGs can quantize to identical bytes,
    // which would hit the cache instead of spawning a fresh job.
    const data = await jpegFixture(2 + i, 2, { r: 0, g: 100, b: 200 });
    keys.push(data);
    const ready = nextReady();
    transcodeToPng(data, "image/jpeg");
    await ready;
  }
  // Newest entries survive regardless of leftovers from earlier tests.
  expect(transcodeToPng(keys[39], "image/jpeg")).not.toBeNull();
  expect(transcodeToPng(keys[38], "image/jpeg")).not.toBeNull();
  // The oldest is gone: lookup misses and spawns a fresh job.
  const ready = nextReady();
  expect(transcodeToPng(keys[0], "image/jpeg")).toBeNull();
  await ready;
  expect(transcodeToPng(keys[0], "image/jpeg")).not.toBeNull();
}, 30000);
