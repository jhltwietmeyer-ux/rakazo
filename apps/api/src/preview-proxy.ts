import {
  isSafePreviewPath,
  PREVIEW_ARTIFACT_MIME_TYPE,
  type PreviewArtifactView,
  parseStoredPreview,
  previewArtifactUrl,
} from "@rakazo/core";
import type { PreviewCapabilityScope } from "@rakazo/core/node/preview-capability";
import {
  openPreviewCapability,
  PREVIEW_ROUTE_PREFIX,
  previewUrl,
  sealPreviewCapability,
} from "@rakazo/core/node/preview-capability";
import type { PrismaClient } from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { cancelBody } from "./http-body.js";

export const PREVIEW_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const PREVIEW_UPSTREAM_TIMEOUT_MS = 30_000;
export const PREVIEW_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;
/** Own policy on every proxied response; upstream CSP never reaches the browser. */
export const PREVIEW_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms; frame-ancestors 'self'";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

/** Request headers the bot's server may see. Cookies and credentials never leave the API. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "range",
  "user-agent",
];

/** Response headers the browser must not get from preview content on the app origin. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "set-cookie2",
  "clear-site-data",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "refresh",
  "strict-transport-security",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
  // fetch() already decoded the body; the original length and encoding no longer match.
  "content-encoding",
  "content-length",
]);

export type PreviewAccess = "ok" | "forbidden" | "expired" | "unavailable";

export interface PreviewUpstream {
  /** e.g. http://supervisor:7091/computers/<ref>/http/5173; the request path is appended. */
  base: string;
  headers?: Record<string, string>;
}

/**
 * Johann's own navigations (address bar, the app's iframe src) must carry a
 * session. Everything the opaque-origin sandbox loads (scripts, styles, its own
 * links and forms) cannot carry the cookie, so the sealed capability alone
 * authorizes it (decision 19.10.2026 12:16 UTC, point 2). Requests without
 * fetch metadata count as navigations.
 */
export function requiresSession(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  const mode = headers.get("sec-fetch-mode");
  if (site === null || mode === null) return true;
  return mode === "navigate" && (site === "same-origin" || site === "none");
}

export interface PreviewProxyDeps {
  secret: string;
  logger: Pick<Logger, "info" | "warn">;
  /** Signed-in user from the request's session cookie, or null. */
  sessionUserId(request: Request): Promise<string | null>;
  /**
   * Bot/computer generation (expired) for the sealed scope and, when a user is
   * signed in, their space membership (forbidden).
   */
  checkAccess(userId: string | null, scope: PreviewCapabilityScope): Promise<PreviewAccess>;
  /**
   * Base URL that reaches `scope.port` on the bot's computer, resolved from
   * computerId on the server side, plus headers for that hop. Null when the
   * computer has no reachable host.
   */
  resolveUpstream(scope: PreviewCapabilityScope): Promise<PreviewUpstream | null>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  rateLimit?: { max: number; windowMs: number };
}

export function mountPreviewProxy(app: Hono, deps: PreviewProxyDeps): void {
  const limiter = createRateLimiter(deps.rateLimit ?? PREVIEW_RATE_LIMIT);
  const handler = (c: Context) => handlePreview(c, deps, limiter);
  app.all(`${PREVIEW_ROUTE_PREFIX}:sealed`, handler);
  app.all(`${PREVIEW_ROUTE_PREFIX}:sealed/*`, handler);
}

async function handlePreview(
  c: Context,
  deps: PreviewProxyDeps,
  limiter: RateLimiter,
): Promise<Response> {
  const method = c.req.method;
  if (!ALLOWED_METHODS.has(method)) {
    cancelBody(c.req.raw.body);
    return jsonError(405, "method_not_allowed", { allow: "GET, HEAD, POST" });
  }
  const now = deps.now?.() ?? Date.now();
  const raw = new URL(c.req.url);
  const parsed = splitPreviewPath(raw.pathname);
  if (!parsed) return jsonError(401, "preview_invalid");

  const userId = await deps.sessionUserId(c.req.raw).catch(() => null);
  if (!userId && requiresSession(c.req.raw.headers)) return jsonError(401, "unauthorized");

  const capability = openPreviewCapability(parsed.sealed, deps.secret, now);
  if (!capability.ok) {
    return capability.reason === "expired"
      ? jsonError(410, "preview_expired")
      : jsonError(401, "preview_invalid");
  }
  const { scope } = capability;
  const access = await deps.checkAccess(userId, scope).catch(() => "unavailable" as const);
  if (access === "forbidden") return jsonError(403, "forbidden");
  if (access === "expired") return jsonError(410, "preview_expired");
  if (access !== "ok") return jsonError(502, "preview_unreachable");

  const rateKey = userId ?? `capability:${scope.botId}:${scope.computerId}:${scope.port}`;
  if (!limiter.take(rateKey, now)) return jsonError(429, "rate_limited", { "retry-after": "60" });

  // The document URL must end in "/" so its relative links stay inside the capability.
  if (parsed.rest === "") {
    return new Response(null, {
      status: 308,
      headers: {
        ...PREVIEW_SECURITY_HEADERS,
        location: `${parsed.prefix}/${raw.search}`,
        "cache-control": "no-store",
      },
    });
  }
  if (!isSafePreviewPath(parsed.rest)) return jsonError(400, "preview_bad_path");

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method === "POST") {
    const read = await readLimitedBody(c.req.raw, PREVIEW_MAX_REQUEST_BYTES);
    if (!read.ok) return jsonError(413, "payload_too_large");
    body = read.body;
  }

  const upstreamTarget = await deps.resolveUpstream(scope).catch(() => null);
  if (!upstreamTarget) return jsonError(502, "preview_unreachable");
  const target = upstreamUrl(upstreamTarget.base, parsed.rest, raw.search);
  if (!target) return jsonError(400, "preview_bad_path");

  const log = {
    "preview.bot_id": scope.botId,
    "preview.computer_id": scope.computerId,
    "preview.port": scope.port,
    "preview.path": parsed.rest,
    "http.method": method,
  };
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.raw.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(upstreamTarget.headers ?? {}))
    headers.set(name, value);

  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? fetch)(target, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? PREVIEW_UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    deps.logger.warn("preview.upstream.failed", { ...log, "preview.timeout": timedOut });
    return timedOut ? jsonError(504, "preview_timeout") : jsonError(502, "preview_unreachable");
  }

  const responseHeaders = filterResponseHeaders(upstream.headers);
  const location = upstream.headers.get("location");
  if (location !== null) {
    const rewritten = rewriteLocation(location, parsed.prefix, scope.port);
    if (rewritten === null) {
      cancelBody(upstream.body);
      deps.logger.warn("preview.redirect.refused", { ...log, "http.status": upstream.status });
      return jsonError(502, "preview_unreachable");
    }
    responseHeaders.set("location", rewritten);
  }
  deps.logger.info("preview.proxied", { ...log, "http.status": upstream.status });
  const empty = method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  if (empty) cancelBody(upstream.body);
  return new Response(empty ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/**
 * Space membership decides access (403); a bot that is gone, archived, moved to
 * another computer, or whose bot/computer screen generation changed makes the
 * capability stale (410). A computer that is not running cannot answer (502).
 */
export function prismaPreviewAccess(prisma: PrismaClient): PreviewProxyDeps["checkAccess"] {
  return async (userId, scope) => {
    const bot = await prisma.bot.findFirst({
      where: { id: scope.botId, computerId: scope.computerId, archivedAt: null },
      select: {
        spaceId: true,
        screenGeneration: true,
        computer: { select: { screenGeneration: true, state: true, providerRef: true } },
      },
    });
    if (!bot) return "expired";
    if (userId !== null) {
      const member = await prisma.spaceMember.findFirst({
        where: { userId, spaceId: bot.spaceId },
        select: { userId: true },
      });
      if (!member) return "forbidden";
    }
    if (
      bot.screenGeneration !== scope.botGeneration ||
      bot.computer?.screenGeneration !== scope.computerGeneration
    )
      return "expired";
    if (bot.computer.state !== "running" || !bot.computer.providerRef) return "unavailable";
    return "ok";
  };
}

/**
 * Docker computers: the API cannot reach the computer network, so it goes
 * through the supervisor relay (GET|HEAD|POST /computers/:ref/http/:port/*).
 * The host comes from the computer row, never from the request.
 */
export function supervisorPreviewUpstream(
  prisma: PrismaClient,
  supervisorUrl: string,
  supervisorToken: string,
): PreviewProxyDeps["resolveUpstream"] {
  return async (scope) => {
    const bot = await prisma.bot.findFirst({
      where: { id: scope.botId, computerId: scope.computerId, archivedAt: null },
      select: {
        computer: { select: { kind: true, providerRef: true, homeKey: true, spaceId: true } },
      },
    });
    const computer = bot?.computer;
    if (!computer?.providerRef || computer.kind !== "docker") return null;
    const base = supervisorUrl.replace(/\/$/, "");
    return {
      base: `${base}/computers/${encodeURIComponent(computer.providerRef)}/http/${scope.port}`,
      // Same identity the sandbox adapter sends (toComputerRef: botId = homeKey).
      headers: {
        authorization: `Bearer ${supervisorToken}`,
        "x-rakazo-bot-id": computer.homeKey,
        "x-rakazo-space-id": computer.spaceId,
      },
    };
  };
}

/**
 * artifacts.get/getById for a preview artifact (AK 6): the stored JSON carries
 * no token, so every read mints a fresh capability. The RPC is session-bound
 * and owner-scoped; this is where session and membership apply again. A bot
 * that is gone, archived or on another computer yields url null.
 */
export async function withSealedPreview<T extends { mimeType: string; contentBase64: string }>(
  prisma: PrismaClient,
  secret: string,
  artifact: T,
  now = Date.now(),
): Promise<T> {
  if (artifact.mimeType !== PREVIEW_ARTIFACT_MIME_TYPE) return artifact;
  const stored = parseStoredPreview(Buffer.from(artifact.contentBase64, "base64"));
  if (!stored) throw new Error("Preview artifact is damaged");
  const bot = await prisma.bot.findFirst({
    where: { id: stored.botId, computerId: stored.computerId, archivedAt: null },
    select: { screenGeneration: true, computer: { select: { screenGeneration: true } } },
  });
  let view: PreviewArtifactView = { ...stored, url: null, expiresAt: null };
  if (bot?.computer) {
    const { sealed, expiresAt } = sealPreviewCapability(
      secret,
      {
        botId: stored.botId,
        computerId: stored.computerId,
        botGeneration: bot.screenGeneration,
        computerGeneration: bot.computer.screenGeneration,
        port: stored.port,
      },
      now,
    );
    view = {
      ...stored,
      url: previewArtifactUrl(previewUrl(sealed), stored.path),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  return { ...artifact, contentBase64: Buffer.from(JSON.stringify(view)).toString("base64") };
}

/** Splits `/api/preview/<sealed>/<rest>` without decoding; rest is "" when the slash is missing. */
export function splitPreviewPath(pathname: string) {
  if (!pathname.startsWith(PREVIEW_ROUTE_PREFIX)) return null;
  const after = pathname.slice(PREVIEW_ROUTE_PREFIX.length);
  const slash = after.indexOf("/");
  const sealed = slash === -1 ? after : after.slice(0, slash);
  if (!sealed) return null;
  return {
    sealed,
    prefix: `${PREVIEW_ROUTE_PREFIX}${sealed}`,
    rest: slash === -1 ? "" : after.slice(slash),
  };
}

export { isSafePreviewPath };

function upstreamUrl(baseUrl: string, path: string, search: string) {
  try {
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/$/, "");
    const url = new URL(`${base.origin}${basePath}${path}${search}`);
    // The URL parser must not have moved us: same origin, path taken verbatim.
    if (url.origin !== base.origin || url.pathname !== `${basePath}${path}`) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function filterResponseHeaders(upstream: Headers) {
  const connectionListed = new Set(
    (upstream.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers = new Headers();
  for (const [name, value] of upstream) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower) || connectionListed.has(lower)) continue;
    headers.append(lower, value);
  }
  const contentType = headers.get("content-type") ?? "";
  if (
    /^\s*text\/html/i.test(contentType) &&
    /attachment/i.test(headers.get("content-disposition") ?? "")
  )
    headers.delete("content-disposition");
  for (const [name, value] of Object.entries(PREVIEW_SECURITY_HEADERS)) headers.set(name, value);
  // Module scripts from the opaque sandbox origin are CORS requests; no credentials.
  headers.set("access-control-allow-origin", "null");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return headers;
}

/**
 * Keeps redirects inside the capability. Root-relative locations get the prefix,
 * path-relative ones pass, absolute ones only when they point at the preview's
 * own server. Anything else (other hosts, "//host", other schemes) is refused.
 */
export function rewriteLocation(location: string, prefix: string, port: number): string | null {
  const value = location.trim();
  if (hasControlCharacter(value) || value.includes("\\")) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/")) return `${prefix}${value}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const own = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);
  if (!own.has(url.origin) || url.username || url.password) return null;
  return `${prefix}${url.pathname}${url.search}${url.hash}`;
}

async function readLimitedBody(
  request: Request,
  max: number,
): Promise<{ ok: true; body: Uint8Array<ArrayBuffer> } | { ok: false }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    cancelBody(request.body);
    return { ok: false };
  }
  if (!request.body) return { ok: true, body: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      cancelBody(reader);
      return { ok: false };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

interface RateLimiter {
  take(key: string, now: number): boolean;
}

/** Fixed window per user, in memory: one API process serves the preview route. */
function createRateLimiter({ max, windowMs }: { max: number; windowMs: number }): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key, now) {
      const current = windows.get(key);
      if (!current || now - current.start >= windowMs) {
        if (windows.size > 10_000) {
          for (const [entryKey, entry] of windows)
            if (now - entry.start >= windowMs) windows.delete(entryKey);
        }
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= max;
    },
  };
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** On every preview response, errors and redirects included (AK 10). */
const PREVIEW_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": PREVIEW_CONTENT_SECURITY_POLICY,
  // The capability lives in the URL; keep it out of Referer headers to other origins.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

function jsonError(status: number, error: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      ...PREVIEW_SECURITY_HEADERS,
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extra,
    },
  });
}
