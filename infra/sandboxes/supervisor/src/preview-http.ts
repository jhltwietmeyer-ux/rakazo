import { COMPUTER_CONTROL_PORT } from "./computer-spec.js";

/**
 * Preview relay (PIV-32): the API reaches an HTTP server on a bot's computer
 * only through this endpoint, because in the isolated screen network the API
 * is not attached to the computer's network. The supervisor token is checked
 * by the /computers/* middleware; this module adds the port policy, the
 * computer identity check and a plain, non-following HTTP relay.
 */

export const PREVIEW_HTTP_MAX_BYTES = 10 * 1024 * 1024;
export const PREVIEW_HTTP_TIMEOUT_MS = 30_000;
export const PREVIEW_HTTP_ROUTE = /^\/computers\/[^/]+\/http\/[^/]+(?:\/.*)?$/;

/** Ports the computer itself uses for control, screens, VNC and browser debugging. */
const RESERVED_PORT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [COMPUTER_CONTROL_PORT, COMPUTER_CONTROL_PORT],
  [5900, 5999],
  [6080, 6095],
  [9222, 9299],
];

export function previewPortAllowed(raw: string): number | null {
  if (!/^[1-9][0-9]{3,4}$/.test(raw)) return null;
  const port = Number(raw);
  if (port < 1024 || port > 65535) return null;
  if (RESERVED_PORT_RANGES.some(([from, to]) => port >= from && port <= to)) return null;
  return port;
}

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

/** Same allow-list as the API proxy; the API already removed cookies and credentials. */
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
];

/** Headers that describe the hop, not the content; fetch() already decoded the body. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

export class PreviewIdentityError extends Error {}

export interface PreviewHttpDeps {
  /** Container address on the computer network; throws PreviewIdentityError on a bot/space mismatch. */
  lookupHost(id: string, botId: string | undefined, spaceId: string | undefined): Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function json(status: number, error: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

/** Handles GET|HEAD|POST /computers/:id/http/:port/<path>. */
export async function relayPreviewHttp(request: Request, deps: PreviewHttpDeps): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/computers\/([^/]+)\/http\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return json(404, "not_found");
  const [, id = "", rawPort = "", rest] = match;
  if (!ALLOWED_METHODS.has(request.method)) {
    return json(405, "method_not_allowed", { allow: "GET, HEAD, POST" });
  }
  const port = previewPortAllowed(rawPort);
  if (port === null) return json(403, "port_not_allowed");

  let host: string;
  try {
    host = await deps.lookupHost(
      decodeURIComponent(id),
      request.headers.get("x-rakazo-bot-id") ?? undefined,
      request.headers.get("x-rakazo-space-id") ?? undefined,
    );
  } catch (error) {
    if (error instanceof PreviewIdentityError) return json(403, "forbidden");
    return json(502, "computer_unreachable");
  }

  const hostPart = host.includes(":") ? `[${host}]` : host;
  const target = new URL(`http://${hostPart}:${port}`);
  target.pathname = rest ?? "/";
  target.search = url.search;
  if (target.host !== `${hostPart}:${port}`) return json(400, "bad_path");

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > PREVIEW_HTTP_MAX_BYTES) return json(413, "payload_too_large");
  }

  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? fetch)(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? PREVIEW_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return json(timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_unreachable");
  }

  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PREVIEW_HTTP_MAX_BYTES) {
    await upstream.body?.cancel().catch(() => undefined);
    return json(502, "upstream_too_large");
  }
  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out.set(name, value);
  });
  const responseBody =
    request.method === "HEAD" || !upstream.body ? null : limitStream(upstream.body);
  return new Response(responseBody, { status: upstream.status, headers: out });
}

/** Cuts a streamed body off after the size limit instead of buffering it. */
function limitStream(body: ReadableStream<Uint8Array>) {
  let size = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > PREVIEW_HTTP_MAX_BYTES) {
          controller.error(new Error("preview response too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
