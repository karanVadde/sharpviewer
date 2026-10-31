/**
 * Image sources: the built-in sample, the stock set, and user uploads.
 *
 * Ids are short slugs (`sample`, `thumb`, ..., `u-<hex>`); paths never come from
 * user input. Uploads live in `uploads/` (git-ignored); SHARP_VIEWER_UPLOADS
 * overrides the directory (the tests use a temp dir).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp, { type FormatEnum, type Metadata } from "sharp";
import { BadRequestError } from "./errors.ts";

export type ImageKind = "sample" | "stock" | "upload";

export interface ImageSource {
  id: string;
  /** Human label: "sample.png", "photo.jpg", or the uploaded file's original name. */
  label: string;
  kind: ImageKind;
  path: string;
}

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export const SAMPLE_IMAGE: ImageSource = { id: "sample", label: "sample.png", kind: "sample", path: here("../public/sample.png") };

export const STOCK_IMAGES: readonly ImageSource[] = [
  { id: "thumb", label: "thumb.png", kind: "stock", path: here("../public/stock/thumb.png") },
  { id: "photo", label: "photo.jpg", kind: "stock", path: here("../public/stock/photo.jpg") },
  { id: "fhd", label: "fhd.jpg", kind: "stock", path: here("../public/stock/fhd.jpg") },
  { id: "portrait", label: "portrait.webp", kind: "stock", path: here("../public/stock/portrait.webp") },
  { id: "panorama", label: "panorama.png", kind: "stock", path: here("../public/stock/panorama.png") },
];

export const uploadsDir = process.env.SHARP_VIEWER_UPLOADS || here("../uploads");

export const IMAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UPLOAD_ID_PATTERN = /^u-[0-9a-f]{16}$/;

/** Upload limits. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Total bytes `uploads/` may hold (A11); oldest uploads are evicted to make room. Env: SHARP_VIEWER_UPLOAD_QUOTA_MB (default 500). */
export const uploadLimits = {
  quotaBytes: (Number(process.env.SHARP_VIEWER_UPLOAD_QUOTA_MB) > 0 ? Number(process.env.SHARP_VIEWER_UPLOAD_QUOTA_MB) : 500) * 1024 * 1024,
};
export const MAX_UPLOAD_SIDE = 8192;
export const MAX_UPLOAD_PIXELS = 50_000_000;
/** sharp format name -> file extension. */
const UPLOAD_FORMATS: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif", tiff: "tiff", avif: "avif" };
export const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/tiff,image/avif";

interface Sidecar {
  name: string;
  uploadedAt: string;
}

/** Test/diagnostic hook: how many times the uploads directory was actually scanned. */
export const uploadIndexStats = { scans: 0 };

/**
 * In-memory index of the uploads directory (A3). Rebuilt when the directory's mtime/ctime
 * changes (file added or removed, by us or by anyone else) and explicitly dropped by our own
 * write paths, so a page view costs one `stat` instead of a `readdir` plus one read per upload.
 */
let uploadIndex: { key: string; uploads: ImageSource[] } | undefined;

/** Drop the cached index (called after every save/remove). */
export function invalidateUploadIndex(): void {
  uploadIndex = undefined;
}

async function directoryKey(): Promise<string> {
  try {
    const s = await stat(uploadsDir);
    return `${s.mtimeMs}:${s.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }
}

async function scanUploads(): Promise<ImageSource[]> {
  uploadIndexStats.scans += 1;
  let entries: string[];
  try {
    entries = await readdir(uploadsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const uploads: Array<ImageSource & { uploadedAt: string }> = [];
  for (const entry of entries) {
    const m = /^(u-[0-9a-f]{16})\.(png|jpg|webp|gif|tiff|avif)$/.exec(entry);
    if (!m) continue;
    const id = m[1]!;
    let sidecar: Sidecar = { name: entry, uploadedAt: "" };
    try {
      sidecar = JSON.parse(await readFile(`${uploadsDir}/${id}.json`, "utf8")) as Sidecar;
    } catch {
      /* missing or unreadable sidecar: fall back to the file name */
    }
    uploads.push({ id, label: sidecar.name, kind: "upload", path: `${uploadsDir}/${entry}`, uploadedAt: sidecar.uploadedAt });
  }
  uploads.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
  return uploads.map(({ uploadedAt: _drop, ...source }) => source);
}

/** Uploaded images, newest first. Tolerates a missing directory. Served from the index when it is current. */
export async function listUploads(): Promise<ImageSource[]> {
  const key = await directoryKey();
  if (uploadIndex?.key !== key) {
    const uploads = await scanUploads();
    uploadIndex = { key: await directoryKey(), uploads };
  }
  return uploadIndex.uploads;
}

/** Every selectable image: sample, stock, then uploads. */
export async function listImages(): Promise<ImageSource[]> {
  return [SAMPLE_IMAGE, ...STOCK_IMAGES, ...(await listUploads())];
}

/** Validate an image id's shape (synchronously, for query parsing). */
export function parseImageId(raw: string | null): string {
  if (raw === null || raw === "") return SAMPLE_IMAGE.id;
  if (!IMAGE_ID_PATTERN.test(raw)) throw new BadRequestError("image must be an image id (letters, digits, dashes).");
  return raw;
}

/** Resolve an id to a source, or throw a BadRequestError naming the known ids. */
export async function resolveImage(id: string): Promise<ImageSource> {
  if (id === SAMPLE_IMAGE.id) return SAMPLE_IMAGE;
  const stock = STOCK_IMAGES.find((s) => s.id === id);
  if (stock) return stock;
  if (UPLOAD_ID_PATTERN.test(id)) {
    const upload = (await listUploads()).find((u) => u.id === id);
    if (upload) return upload;
  }
  throw new BadRequestError(`Unknown image "${id}". Known images: ${[SAMPLE_IMAGE, ...STOCK_IMAGES].map((s) => s.id).join(", ")}, or an upload id.`);
}

/** Sanitise an uploaded file name for display (never used as a path). */
function displayName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(-80);
  return cleaned || "upload";
}

/**
 * Validate and store an upload. Decodes with sharp to prove it is an image, enforces
 * the limits, applies EXIF orientation (re-encoding only when the tag is non-default)
 * and writes atomically. Returns the new source.
 */
export async function saveUpload(originalName: string, bytes: Buffer): Promise<ImageSource> {
  if (bytes.length === 0) throw new BadRequestError("Upload: no file was selected.");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new BadRequestError(`Upload: file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS }).metadata();
  } catch {
    throw new BadRequestError("Upload: the file is not an image sharp can read (PNG, JPEG, WebP, GIF, TIFF or AVIF).");
  }
  const ext = meta.format ? UPLOAD_FORMATS[meta.format] : undefined;
  if (!ext) throw new BadRequestError(`Upload: ${meta.format ?? "unknown"} files are not supported (PNG, JPEG, WebP, GIF, TIFF or AVIF).`);
  const width = meta.width ?? 0,
    height = meta.height ?? 0;
  if (width < 1 || height < 1) throw new BadRequestError("Upload: the image has no pixels.");
  if (width > MAX_UPLOAD_SIDE || height > MAX_UPLOAD_SIDE || width * height > MAX_UPLOAD_PIXELS) {
    throw new BadRequestError(
      `Upload: ${width}x${height} is too large; the limit is ${MAX_UPLOAD_SIDE} px per side and ${MAX_UPLOAD_PIXELS / 1_000_000} megapixels.`,
    );
  }

  // Phone photos carry an EXIF orientation; bake it in once so every later render is upright
  // (sharp 0.33 cannot combine EXIF auto-orient with an explicit rotate in one pipeline).
  // The single re-encode is near-lossless (B5): JPEG q95 4:4:4, WebP q95, the rest lossless / default.
  let stored = bytes;
  if (meta.orientation !== undefined && meta.orientation !== 1) {
    try {
      const upright = sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS }).rotate();
      stored = await (meta.format === "jpeg"
        ? upright.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        : meta.format === "webp"
          ? upright.webp({ quality: 95 })
          : upright.toFormat(meta.format as keyof FormatEnum)
      ).toBuffer();
    } catch {
      throw new BadRequestError("Upload: the image could not be decoded.");
    }
  }

  if (stored.length > uploadLimits.quotaBytes) {
    throw new BadRequestError(
      `Upload: ${(stored.length / 1024 / 1024).toFixed(1)} MB exceeds the uploads quota of ${(uploadLimits.quotaBytes / 1024 / 1024).toFixed(0)} MB.`,
    );
  }
  await evictForQuota(stored.length);

  await mkdir(uploadsDir, { recursive: true });
  const id = `u-${randomBytes(8).toString("hex")}`;
  const finalPath = `${uploadsDir}/${id}.${ext}`;
  const tmp = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmp, stored);
  await rename(tmp, finalPath);
  const sidecar: Sidecar = { name: displayName(originalName), uploadedAt: new Date().toISOString() };
  await writeFile(`${uploadsDir}/${id}.json`, JSON.stringify(sidecar), "utf8");
  invalidateUploadIndex();
  return { id, label: sidecar.name, kind: "upload", path: finalPath };
}

/** Remove the oldest uploads until `incoming` more bytes fit under the quota. */
async function evictForQuota(incoming: number): Promise<void> {
  const uploads = await listUploads(); // newest first
  const sizes = await Promise.all(uploads.map(async (u) => (await stat(u.path).catch(() => ({ size: 0 }))).size));
  let total = sizes.reduce((n, s) => n + s, 0) + incoming;
  for (let i = uploads.length - 1; i >= 0 && total > uploadLimits.quotaBytes; i--) {
    await removeUpload(uploads[i]!.id);
    total -= sizes[i]!;
  }
}

/** Delete an upload (and its sidecar). Unknown id -> BadRequestError. */
export async function removeUpload(id: string): Promise<void> {
  if (!UPLOAD_ID_PATTERN.test(id)) throw new BadRequestError(`"${id}" is not an upload id.`);
  const upload = (await listUploads()).find((u) => u.id === id);
  if (!upload) throw new BadRequestError(`Unknown upload "${id}".`);
  await unlink(upload.path);
  try {
    await unlink(`${uploadsDir}/${id}.json`);
  } catch {
    /* sidecar already gone */
  }
  invalidateUploadIndex();
}

/** mtime+size key for cache invalidation ("none" when missing). */
export async function fileKey(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "none";
  }
}
