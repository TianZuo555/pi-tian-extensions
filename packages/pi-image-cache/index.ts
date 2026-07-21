import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDimensionNote, getAgentDir, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTENSION_ID = "image-cache";
const CACHE_ROOT = join(getAgentDir(), "cache", EXTENSION_ID);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLACEHOLDER_RE = /\[Image#(\d{3,})\]/g;
const PI_CLIPBOARD_PATH_RE = /(?:^|[\s"'`(<])((?:\/private)?\/var\/folders\/[^\s"'`<>)]*\/T\/pi-clipboard-[A-Za-z0-9-]+\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`)>.,;:!?])/gi;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
};

const MODEL_SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type CachedImage = {
  id: number;
  placeholder: string;
  filePath: string;
  mimeType: string;
  createdAt: number;
  sourcePath?: string;
};

type Manifest = {
  version: 1;
  images: CachedImage[];
};

let cacheDir = join(CACHE_ROOT, `process-${process.pid}`);
let manifestPath = join(cacheDir, "manifest.json");
let nextImageId = 1;
const imagesByPlaceholder = new Map<string, CachedImage>();

function formatPlaceholder(id: number): string {
  return `[Image#${String(id).padStart(3, "0")}]`;
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() || mimeType.toLowerCase();
}

function detectMimeType(filePath: string, bytes: Buffer): string | undefined {
  if (bytes.length >= 12) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    const head6 = bytes.subarray(0, 6).toString("ascii");
    if (head6 === "GIF87a" || head6 === "GIF89a") {
      return "image/gif";
    }
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
      return "image/webp";
    }
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    ) {
      return "image/tiff";
    }
    if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
      const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
      if (brand.startsWith("hei") || brand.startsWith("mif")) {
        return brand.startsWith("mif") ? "image/heif" : "image/heic";
      }
    }
  }

  return MIME_BY_EXT[extname(filePath).toLowerCase()];
}

function imageExtension(mimeType: string): string {
  return EXT_BY_MIME[normalizeMimeType(mimeType)] ?? "png";
}

async function ensureCacheDir(): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
}

async function cleanupOldCaches(): Promise<void> {
  try {
    await mkdir(CACHE_ROOT, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(CACHE_ROOT, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = join(CACHE_ROOT, entry.name);
          try {
            const info = await stat(fullPath);
            if (now - info.mtimeMs > CACHE_TTL_MS) {
              await rm(fullPath, { recursive: true, force: true });
            }
          } catch {
            // Ignore cleanup failures.
          }
        }),
    );
  } catch {
    // Ignore cleanup failures.
  }
}

async function loadManifest(): Promise<void> {
  imagesByPlaceholder.clear();
  nextImageId = 1;

  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Manifest;
    for (const image of manifest.images ?? []) {
      if (!existsSync(image.filePath)) continue;
      imagesByPlaceholder.set(image.placeholder, image);
      nextImageId = Math.max(nextImageId, image.id + 1);
    }
  } catch {
    // No manifest yet, or it is stale/corrupt.
  }
}

async function saveManifest(): Promise<void> {
  await ensureCacheDir();
  const manifest: Manifest = {
    version: 1,
    images: [...imagesByPlaceholder.values()],
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

async function convertToPngWithSips(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("/usr/bin/sips", ["-s", "format", "png", inputPath, "--out", outputPath], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function cacheExistingImage(sourcePath: string): Promise<CachedImage | null> {
  const bytes = await readFile(sourcePath);
  const detectedMime = detectMimeType(sourcePath, bytes);
  if (!detectedMime) return null;

  await ensureCacheDir();
  const id = nextImageId++;
  const placeholder = formatPlaceholder(id);
  let mimeType = normalizeMimeType(detectedMime);
  let filePath = join(cacheDir, `${placeholder.slice(1, -1)}.${imageExtension(mimeType)}`);

  if (MODEL_SUPPORTED_MIMES.has(mimeType)) {
    await copyFile(sourcePath, filePath);
  } else {
    filePath = join(cacheDir, `${placeholder.slice(1, -1)}.png`);
    await convertToPngWithSips(sourcePath, filePath);
    mimeType = "image/png";
  }

  const cached: CachedImage = {
    id,
    placeholder,
    filePath,
    mimeType,
    createdAt: Date.now(),
    sourcePath,
  };
  imagesByPlaceholder.set(placeholder, cached);
  await saveManifest();
  return cached;
}

async function readMacClipboardImageToCache(): Promise<CachedImage | null> {
  if (process.platform !== "darwin") return null;

  await ensureCacheDir();
  const rawPath = join(cacheDir, `clipboard-${randomUUID()}.raw`);
  const quotedPath = JSON.stringify(rawPath);
  const script = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const out = ${quotedPath};
const pb = $.NSPasteboard.generalPasteboard;
const candidates = [
  ['public.png', 'image/png', 'png'],
  ['public.jpeg', 'image/jpeg', 'jpg'],
  ['public.tiff', 'image/tiff', 'tiff'],
  ['com.compuserve.gif', 'image/gif', 'gif'],
  ['org.webmproject.webp', 'image/webp', 'webp'],
  ['public.webp', 'image/webp', 'webp'],
  ['public.heic', 'image/heic', 'heic'],
  ['public.heif', 'image/heif', 'heif'],
];
let wrote = false;
for (const [uti, mime, ext] of candidates) {
  const data = pb.dataForType(uti);
  if (data && data.length > 0) {
    if (!data.writeToFileAtomically(out, true)) {
      throw new Error('failed to write clipboard image');
    }
    console.log(mime + '|' + ext);
    wrote = true;
    break;
  }
}
if (!wrote) {
  throw new Error('clipboard does not contain a supported image');
}
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const [mimeRaw, extRaw] = stdout.trim().split("|");
    let mimeType = normalizeMimeType(mimeRaw || "image/png");
    const ext = extRaw || imageExtension(mimeType);

    const id = nextImageId++;
    const placeholder = formatPlaceholder(id);
    let filePath = join(cacheDir, `${placeholder.slice(1, -1)}.${ext}`);

    if (MODEL_SUPPORTED_MIMES.has(mimeType)) {
      await rename(rawPath, filePath);
    } else {
      filePath = join(cacheDir, `${placeholder.slice(1, -1)}.png`);
      await convertToPngWithSips(rawPath, filePath);
      await unlink(rawPath).catch(() => undefined);
      mimeType = "image/png";
    }

    const cached: CachedImage = {
      id,
      placeholder,
      filePath,
      mimeType,
      createdAt: Date.now(),
    };
    imagesByPlaceholder.set(placeholder, cached);
    await saveManifest();
    return cached;
  } catch {
    await unlink(rawPath).catch(() => undefined);
    return null;
  }
}

async function toImageContent(cached: CachedImage): Promise<{ content: ImageContent; note?: string }> {
  const bytes = await readFile(cached.filePath);
  const resized = cached.mimeType === "image/gif"
    ? null
    : await resizeImage(bytes, cached.mimeType, { maxWidth: 2000, maxHeight: 2000 });

  if (resized) {
    return {
      content: {
        type: "image",
        mimeType: resized.mimeType,
        data: resized.data,
      },
      note: formatDimensionNote(resized),
    };
  }

  return {
    content: {
      type: "image",
      mimeType: cached.mimeType,
      data: bytes.toString("base64"),
    },
  };
}

function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const placeholder = match[0];
    if (!found.includes(placeholder)) found.push(placeholder);
  }
  return found;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.() ?? `process-${process.pid}`;
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    cacheDir = join(CACHE_ROOT, safeSessionId);
    manifestPath = join(cacheDir, "manifest.json");
    await ensureCacheDir();
    await cleanupOldCaches();
    await loadManifest();
    ctx.ui.setStatus(EXTENSION_ID, `images: ${imagesByPlaceholder.size}`);
  });

  if (process.platform === "darwin") {
    pi.registerShortcut("ctrl+v", {
      description: "Paste clipboard image as [Image#xxx]",
      handler: async (ctx) => {
        const cached = await readMacClipboardImageToCache();
        if (!cached) {
          ctx.ui.notify("Clipboard does not contain an image Pi can cache", "warning");
          return;
        }

        ctx.ui.pasteToEditor(cached.placeholder);
        ctx.ui.setStatus(EXTENSION_ID, `images: ${imagesByPlaceholder.size}`);
        ctx.ui.notify(`Cached ${cached.placeholder} (${basename(cached.filePath)})`, "info");
      },
    });
  }

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    let text = event.text;
    const newlyCached: CachedImage[] = [];

    text = await replaceAsync(text, PI_CLIPBOARD_PATH_RE, async (fullMatch, imagePath: string) => {
      const prefix = fullMatch.slice(0, fullMatch.indexOf(imagePath));
      try {
        const cached = await cacheExistingImage(imagePath);
        if (!cached) return fullMatch;
        newlyCached.push(cached);
        return `${prefix}${cached.placeholder}`;
      } catch {
        ctx.ui.notify(`Could not cache pasted image path: ${imagePath}`, "warning");
        return fullMatch;
      }
    });

    const placeholders = findPlaceholders(text);
    if (placeholders.length === 0 && newlyCached.length === 0) {
      return { action: "continue" };
    }

    const attached: ImageContent[] = [...(event.images ?? [])];
    const notes: string[] = [];

    for (const placeholder of placeholders) {
      const cached = imagesByPlaceholder.get(placeholder);
      if (!cached) {
        ctx.ui.notify(`${placeholder} is not in the temporary image cache`, "warning");
        continue;
      }

      try {
        const { content, note } = await toImageContent(cached);
        attached.push(content);
        if (note) notes.push(`${placeholder}: ${note}`);
      } catch {
        ctx.ui.notify(`Could not attach ${placeholder} from cache`, "warning");
      }
    }

    if (attached.length === (event.images?.length ?? 0)) {
      return { action: "transform", text };
    }

    if (notes.length > 0) {
      text += `\n\n<image-cache-notes>\n${notes.join("\n")}\n</image-cache-notes>`;
    }

    ctx.ui.setStatus(EXTENSION_ID, `images: ${imagesByPlaceholder.size}`);
    return { action: "transform", text, images: attached };
  });

  pi.registerCommand("images", {
    description: "List temporarily cached pasted images",
    handler: async (_args, ctx) => {
      if (imagesByPlaceholder.size === 0) {
        ctx.ui.notify("No cached images in this Pi session", "info");
        return;
      }

      const lines = [...imagesByPlaceholder.values()].map((image) => {
        const ageSeconds = Math.max(0, Math.round((Date.now() - image.createdAt) / 1000));
        return `${image.placeholder}  ${image.mimeType}  ${ageSeconds}s old  ${image.filePath}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("image-cache-clear", {
    description: "Clear temporarily cached pasted images",
    handler: async (_args, ctx) => {
      imagesByPlaceholder.clear();
      nextImageId = 1;
      await rm(cacheDir, { recursive: true, force: true });
      await ensureCacheDir();
      await saveManifest();
      ctx.ui.setStatus(EXTENSION_ID, "images: 0");
      ctx.ui.notify("Image cache cleared", "info");
    },
  });
}

async function replaceAsync(
  text: string,
  regex: RegExp,
  replacer: (fullMatch: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...text.matchAll(regex)];
  if (matches.length === 0) return text;

  let result = "";
  let lastIndex = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    result += text.slice(lastIndex, index);
    result += await replacer(match[0], ...(match.slice(1) as string[]));
    lastIndex = index + match[0].length;
  }
  result += text.slice(lastIndex);
  return result;
}
