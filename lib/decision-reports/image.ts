import { createHash } from "node:crypto";
import sharp from "sharp";

if (typeof window !== "undefined") throw new Error("Decision Report image processing is server-only.");

export const REPORT_IMAGE_LIMITS = {
  maxInputBytes: 5 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 16_000_000,
} as const;

export type SanitizedReportImage = {
  bytes: Buffer;
  mediaType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
  width: number;
  height: number;
  contentHash: string;
};

export class ReportImageError extends Error {
  readonly code:
    | "empty"
    | "too_large"
    | "unsupported"
    | "malformed"
    | "animated"
    | "dimensions"
    | "color";

  constructor(
    code:
      | "empty"
      | "too_large"
      | "unsupported"
      | "malformed"
      | "animated"
      | "dimensions"
      | "color",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ReportImageError";
  }
}

function sniff(bytes: Buffer): "png" | "jpeg" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "png";
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return null;
}

function hasExactPngBoundary(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") return length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

function hasExactJpegBoundary(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

export async function sanitizeReportImage(input: Uint8Array): Promise<SanitizedReportImage> {
  const source = Buffer.from(input);
  if (source.length === 0) throw new ReportImageError("empty", "Choose a PNG or JPEG image to upload.");
  if (source.length > REPORT_IMAGE_LIMITS.maxInputBytes) {
    throw new ReportImageError("too_large", "The image must be 5 MB or smaller.");
  }
  const kind = sniff(source);
  if (!kind) throw new ReportImageError("unsupported", "Use a real PNG or JPEG image.");
  if ((kind === "png" && !hasExactPngBoundary(source)) || (kind === "jpeg" && !hasExactJpegBoundary(source))) {
    throw new ReportImageError("malformed", "The image is truncated or contains trailing data.");
  }

  try {
    const decoder = sharp(source, {
      animated: true,
      failOn: "error",
      limitInputPixels: REPORT_IMAGE_LIMITS.maxPixels,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    if (metadata.format !== kind) throw new ReportImageError("unsupported", "The image format is ambiguous.");
    if ((metadata.pages ?? 1) !== 1) throw new ReportImageError("animated", "Animated images are not supported.");
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (
      width < 1 || height < 1 || width > REPORT_IMAGE_LIMITS.maxWidth ||
      height > REPORT_IMAGE_LIMITS.maxHeight || width * height > REPORT_IMAGE_LIMITS.maxPixels
    ) {
      throw new ReportImageError("dimensions", "The image must be at most 4096×4096 and 16 megapixels.");
    }
    if (metadata.space && !["srgb", "rgb", "b-w"].includes(metadata.space)) {
      throw new ReportImageError("color", "Use an RGB, sRGB, or grayscale image.");
    }

    const normalized = sharp(source, {
      animated: false,
      failOn: "error",
      limitInputPixels: REPORT_IMAGE_LIMITS.maxPixels,
    }).rotate().toColorspace("srgb");
    const encoded = kind === "png"
      ? await normalized.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer({ resolveWithObject: true })
      : await normalized.jpeg({ quality: 88, chromaSubsampling: "4:4:4", progressive: false, mozjpeg: false }).toBuffer({ resolveWithObject: true });

    return {
      bytes: encoded.data,
      mediaType: kind === "png" ? "image/png" : "image/jpeg",
      extension: kind === "png" ? "png" : "jpg",
      width: encoded.info.width,
      height: encoded.info.height,
      contentHash: createHash("sha256").update(encoded.data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ReportImageError) throw error;
    throw new ReportImageError("malformed", "Causent could not safely decode that image. Try exporting it again as PNG or JPEG.");
  }
}
