import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { SCREEN_PROXY_TTL_MS } from "./screen-capability.js";

/**
 * Preview capabilities seal a bot computer's HTTP port for the API preview proxy.
 * They use the screen proxy's secret and AES-256-GCM scheme, but their own
 * additional data ("preview:<expiresAt>"), so a screen seal never opens here and
 * a preview seal never opens as a screen. The upstream host is not sealed: the
 * proxy resolves it from computerId at request time.
 */
export const PREVIEW_PROXY_TTL_MS = SCREEN_PROXY_TTL_MS;
export const PREVIEW_ROUTE_PREFIX = "/api/preview/";
export const PREVIEW_MIN_PORT = 1024;
export const PREVIEW_MAX_PORT = 65535;

export interface PreviewCapabilityScope {
  botId: string;
  computerId: string;
  botGeneration: number;
  computerGeneration: number;
  port: number;
}

export type OpenedPreviewCapability =
  | { ok: true; scope: PreviewCapabilityScope; expiresAt: number }
  | { ok: false; reason: "invalid" | "expired" };

export function isPreviewPort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= PREVIEW_MIN_PORT &&
    port <= PREVIEW_MAX_PORT
  );
}

/** Returns the sealed path segment `<expiresAt>.<token>`. */
export function sealPreviewCapability(
  secret: string,
  scope: PreviewCapabilityScope,
  now = Date.now(),
) {
  if (!secret) throw new Error("Preview secret is missing");
  if (!isPreviewPort(scope.port)) throw new Error("Invalid preview port");
  const expiresAt = now + PREVIEW_PROXY_TTL_MS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", previewKey(secret), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`preview:${expiresAt}`));
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({
        scope: {
          botId: scope.botId,
          computerId: scope.computerId,
          botGeneration: scope.botGeneration,
          computerGeneration: scope.computerGeneration,
          port: scope.port,
        },
      }),
      "utf8",
    ),
    cipher.final(),
  ]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  return { sealed: `${expiresAt}.${token}`, expiresAt };
}

export function previewUrl(sealed: string) {
  return `${PREVIEW_ROUTE_PREFIX}${sealed}/`;
}

/**
 * Opens a sealed segment. Anything that fails authentication or shape checks is
 * "invalid"; only an authentic seal past its expiry is "expired", so a forged
 * expiry cannot turn an invalid token into a 410.
 */
export function openPreviewCapability(
  sealed: string | undefined,
  secret: string,
  now = Date.now(),
): OpenedPreviewCapability {
  const match = sealed?.match(/^(\d{1,16})\.([A-Za-z0-9_-]{40,4096})$/);
  if (!match || !secret) return { ok: false, reason: "invalid" };
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt)) return { ok: false, reason: "invalid" };
  let scope: PreviewCapabilityScope;
  try {
    const raw = Buffer.from(match[2]!, "base64url");
    if (raw.length < 29) return { ok: false, reason: "invalid" };
    const decipher = createDecipheriv("aes-256-gcm", previewKey(secret), raw.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(`preview:${expiresAt}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"),
    ) as { scope?: Partial<PreviewCapabilityScope> } | null;
    const candidate = payload?.scope;
    if (
      !candidate ||
      typeof candidate.botId !== "string" ||
      !candidate.botId ||
      typeof candidate.computerId !== "string" ||
      !candidate.computerId ||
      !Number.isSafeInteger(candidate.botGeneration) ||
      !Number.isSafeInteger(candidate.computerGeneration) ||
      !isPreviewPort(candidate.port)
    )
      return { ok: false, reason: "invalid" };
    scope = candidate as PreviewCapabilityScope;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, scope, expiresAt };
}

function previewKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}
