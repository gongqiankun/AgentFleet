export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 128 * 1024;
export const MAX_IMAGE_URL_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32;

/** Only bounded inline raster images. Never fetch URLs or read user-supplied host paths. */
export function validImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_IMAGE_URL_LENGTH) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]) return false;
  return match[1] === "png" ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === "jpeg" ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
export function parseImages(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES || !value.every(validImageUrl))
    throw new Error("图片格式或大小无效：最多 4 张 PNG/JPEG/WebP，每张发送大小不超过 128 KiB，请重新粘贴");
  return value as string[];
}

