/**
 * Preview artifacts (PIV-32, decision 19.10.2026 12:16 UTC): an ordinary
 * artifact row with this media type. The stored content names the bot's
 * server but never carries a token; the sealed URL is minted only when the
 * artifact is read (artifacts.get/getById), where session and membership apply.
 */
export const PREVIEW_ARTIFACT_MIME_TYPE = "application/vnd.rakazo.preview+json";

/** What is stored. */
export interface StoredPreview {
  title: string;
  port: number;
  path: string;
  botId: string;
  computerId: string;
  description: string | null;
}

/** What artifacts.get returns as content for a preview (Schnittstelle 1). */
export interface PreviewArtifactView extends StoredPreview {
  /** "/api/preview/<sealed>/" + path without the leading slash; null when the computer no longer matches. */
  url: string | null;
  /** ISO-8601; null together with url. */
  expiresAt: string | null;
}

export const PREVIEW_TITLE_MAX_LENGTH = 200;
export const PREVIEW_DESCRIPTION_MAX_LENGTH = 2_000;
export const PREVIEW_PATH_MAX_LENGTH = 1_024;

/**
 * Ports the computer uses itself: control service, screens (noVNC), VNC and
 * browser debugging. A preview may never reach them.
 */
const RESERVED_PREVIEW_PORT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [5900, 5999],
  [6080, 6095],
  [7070, 7070],
  [9222, 9299],
];

export function isAllowedPreviewPort(port: unknown): port is number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535)
    return false;
  return !RESERVED_PREVIEW_PORT_RANGES.some(([from, to]) => port >= from && port <= to);
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A path inside the preview: absolute, no "." / ".." segments, no encoded separators. */
export function isSafePreviewPath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("//") || path.includes("\\")) return false;
  if (hasControlCharacter(path)) return false;
  if (/%(?:2f|5c|00)/i.test(path)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (hasControlCharacter(decoded) || decoded.includes("\\")) return false;
  return decoded.split("/").every((segment) => segment !== "." && segment !== "..");
}

/** Tool input path → stored path ("/" by default), or null when unsafe. Query and fragment are not allowed. */
export function normalizePreviewPath(path: unknown): string | null {
  if (path === undefined || path === null || path === "") return "/";
  if (typeof path !== "string" || path.length > PREVIEW_PATH_MAX_LENGTH) return null;
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  if (/[?#]/.test(withSlash)) return null;
  return isSafePreviewPath(withSlash) ? withSlash : null;
}

export function encodeStoredPreview(preview: StoredPreview): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(preview));
}

/** Strict: anything that is not exactly a stored preview is null. */
export function parseStoredPreview(bytes: Uint8Array): StoredPreview | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { title, port, path, botId, computerId, description } = record;
  if (typeof title !== "string" || title.length === 0) return null;
  if (!isAllowedPreviewPort(port)) return null;
  if (typeof path !== "string" || normalizePreviewPath(path) !== path) return null;
  if (typeof botId !== "string" || botId.length === 0) return null;
  if (typeof computerId !== "string" || computerId.length === 0) return null;
  if (description !== null && typeof description !== "string") return null;
  return { title, port, path, botId, computerId, description };
}

export function previewArtifactUrl(sealedUrl: string, path: string): string {
  return `${sealedUrl}${path.slice(1)}`;
}
