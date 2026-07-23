import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";

import { ReportImageError, sanitizeReportImage } from "./image.ts";

async function png(width = 4, height = 3) {
  return sharp({ create: { width, height, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 0.8 } } })
    .withMetadata({ exif: { IFD0: { Copyright: "secret metadata" } } })
    .png().toBuffer();
}

test("sanitizes deterministically and strips PNG metadata", async () => {
  const source = await png();
  const first = await sanitizeReportImage(source);
  const second = await sanitizeReportImage(source);
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.mediaType, "image/png");
  assert.equal(first.width, 4);
  assert.equal((await sharp(first.bytes).metadata()).exif, undefined);
  assert.equal((await sharp(first.bytes).metadata()).icc, undefined);
  assert.equal(first.bytes.includes(Buffer.from("secret metadata")), false);
});

test("normalizes JPEG and does not preserve the original bytes", async () => {
  const source = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#abcdef" } })
    .withMetadata({ exif: { IFD0: { Copyright: "private" } } }).jpeg({ quality: 95 }).toBuffer();
  const result = await sanitizeReportImage(source);
  assert.equal(result.mediaType, "image/jpeg");
  assert.equal(result.extension, "jpg");
  assert.notDeepEqual(result.bytes, source);
  assert.equal((await sharp(result.bytes).metadata()).exif, undefined);
});

test("reports the sanitized dimensions after applying JPEG orientation", async () => {
  const source = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#abcdef" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const result = await sanitizeReportImage(source);
  assert.deepEqual([result.width, result.height], [2, 3]);
  const metadata = await sharp(result.bytes).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.orientation], [2, 3, undefined]);
});

test("rejects unsupported signatures, truncation, and polyglot trailing bytes", async () => {
  await assert.rejects(() => sanitizeReportImage(Buffer.from("not an image")), (error: unknown) => error instanceof ReportImageError && error.code === "unsupported");
  const source = await png();
  await assert.rejects(() => sanitizeReportImage(source.subarray(0, source.length - 5)), (error: unknown) => error instanceof ReportImageError && error.code === "malformed");
  await assert.rejects(() => sanitizeReportImage(Buffer.concat([source, Buffer.from("<script>bad()</script>")])), (error: unknown) => error instanceof ReportImageError && error.code === "malformed");
});

test("rejects decoded dimensions over the conservative cap", async () => {
  const source = await png(4097, 1);
  await assert.rejects(() => sanitizeReportImage(source), (error: unknown) => error instanceof ReportImageError && error.code === "dimensions");
});
