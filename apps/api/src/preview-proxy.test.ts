import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PREVIEW_ARTIFACT_MIME_TYPE } from "@rakazo/core";
import {
  type PreviewCapabilityScope,
  previewUrl,
  sealPreviewCapability,
} from "@rakazo/core/node/preview-capability";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink } from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isSafePreviewPath,
  mountPreviewProxy,
  type PreviewAccess,
  type PreviewProxyDeps,
  prismaPreviewAccess,
  rewriteLocation,
  supervisorPreviewUpstream,
  withSealedPreview,
} from "./preview-proxy.js";

const secret = "test-screen-proxy-secret-0123456789abcdef";
const scope: PreviewCapabilityScope = {
  botId: "bot_a",
  computerId: "computer_a",
  botGeneration: 2,
  computerGeneration: 5,
  port: 8080,
};
const SESSION = "session=member";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
let upstream: Server;
let upstreamOrigin: string;
let closedOrigin: string;
const seen: Seen[] = [];

function handleUpstream(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const path = (req.url ?? "").split("?")[0];
    if (path === "/hang") return; // never answers
    if (path === "/redirect-root") {
      res.writeHead(302, { location: "/login?next=1" });
      return res.end();
    }
    if (path === "/redirect-relative") {
      res.writeHead(302, { location: "next/page" });
      return res.end();
    }
    if (path === "/redirect-self") {
      res.writeHead(301, { location: `http://localhost:${scope.port}/home#top` });
      return res.end();
    }
    if (path === "/redirect-evil") {
      res.writeHead(302, { location: "https://evil.example/steal" });
      return res.end();
    }
    if (path === "/redirect-scheme-relative") {
      res.writeHead(302, { location: "//evil.example/steal" });
      return res.end();
    }
    if (path === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("nope");
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=5",
      "set-cookie": "upstream=1; Path=/",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "clear-site-data": '"cookies"',
      "content-disposition": "attachment; filename=x.html",
      "access-control-allow-origin": "*",
      refresh: "0; url=https://evil.example",
      "x-custom": "kept",
      connection: "close, x-hop",
      "x-hop": "dropped",
    });
    res.end(`<p>ok ${req.method} ${req.url}</p>`);
  });
}

beforeAll(async () => {
  upstream = createServer(handleUpstream);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  closedOrigin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function setup(overrides: Partial<PreviewProxyDeps> & { access?: PreviewAccess } = {}) {
  const sink = createTestSink();
  const logger = createLogger({ service: "api-test", level: "debug", sinks: [sink] });
  const app = new Hono();
  app.use("*", requestLogging(logger));
  const resolved: PreviewCapabilityScope[] = [];
  mountPreviewProxy(app, {
    secret,
    logger,
    sessionUserId: async (request) =>
      request.headers.get("cookie") === SESSION ? "user_member" : null,
    checkAccess: async () => overrides.access ?? "ok",
    resolveUpstream: async (opened) => {
      resolved.push(opened);
      return { base: upstreamOrigin };
    },
    ...overrides,
  });
  return { app, sink, resolved };
}

function sealed(override: Partial<PreviewCapabilityScope> = {}, now = Date.now()) {
  return sealPreviewCapability(secret, { ...scope, ...override }, now).sealed;
}

function call(
  app: Hono,
  path: string,
  init: RequestInit & { cookie?: string | null } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie !== null) headers.set("cookie", init.cookie ?? SESSION);
  return Promise.resolve(app.request(`http://app.example.test${path}`, { ...init, headers }));
}

describe("preview proxy: access", () => {
  it("answers 401 without a session, before anything reaches the bot", async () => {
    const { app, resolved } = setup();
    const response = await call(app, previewUrl(sealed()), { cookie: null });
    expect(response.status).toBe(401);
    expect(resolved).toHaveLength(0);
  });

  it("answers 403 for a session outside the capability's space", async () => {
    const { app, resolved } = setup({ access: "forbidden" });
    expect((await call(app, previewUrl(sealed()))).status).toBe(403);
    expect(resolved).toHaveLength(0);
  });

  it("answers 410 preview_expired for an expired capability or a changed generation", async () => {
    const { app } = setup();
    const old = sealed({}, Date.now() - 61 * 60_000);
    const expired = await call(app, previewUrl(old));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "preview_expired" });

    const stale = setup({ access: "expired" });
    const response = await call(stale.app, previewUrl(sealed()));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "preview_expired" });
  });

  it("never answers 200 to a manipulated token", async () => {
    const { app, resolved } = setup();
    const good = sealed();
    const [expiry, token] = good.split(".") as [string, string];
    const flipped = Buffer.from(token, "base64url");
    flipped[20] = flipped[20]! ^ 0x01;
    const variants = [
      `${expiry}.${flipped.toString("base64url")}`,
      `${Number(expiry) + 1}.${token}`,
      `${Date.now() - 1}.${token}`,
      `${expiry}.${token.slice(0, -2)}`,
      "garbage",
    ];
    for (const variant of variants) {
      const response = await call(app, previewUrl(variant));
      expect([401, 410]).toContain(response.status);
    }
    expect(resolved).toHaveLength(0);
  });

  it("answers 502 preview_unreachable when the bot's port does not answer", async () => {
    const { app } = setup({ resolveUpstream: async () => ({ base: closedOrigin }) });
    const response = await call(app, previewUrl(sealed()));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "preview_unreachable" });

    const stopped = setup({ access: "unavailable" });
    expect((await call(stopped.app, previewUrl(sealed()))).status).toBe(502);
    const unresolved = setup({ resolveUpstream: async () => null });
    expect((await call(unresolved.app, previewUrl(sealed()))).status).toBe(502);
  });

  it("serves HEAD as the reachability check", async () => {
    const { app } = setup();
    const response = await call(app, previewUrl(sealed()), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("allows only GET, HEAD and POST", async () => {
    const { app } = setup();
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await call(app, previewUrl(sealed()), { method });
      expect(response.status).toBe(405);
    }
  });

  it("rate-limits per user with 429", async () => {
    const { app } = setup({ rateLimit: { max: 3, windowMs: 60_000 } });
    const url = previewUrl(sealed());
    for (let index = 0; index < 3; index += 1)
      expect((await call(app, url, { method: "HEAD" })).status).toBe(200);
    expect((await call(app, url, { method: "HEAD" })).status).toBe(429);
  });
});

describe("preview proxy: forwarding", () => {
  it("resolves the host from the sealed scope and never from the request", async () => {
    const { app, resolved } = setup();
    seen.length = 0;
    const response = await call(app, `${previewUrl(sealed())}page?x=1&y=two`, {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        authorization: "Bearer user-token",
        origin: "https://evil.example",
        accept: "text/html",
      },
    });
    expect(response.status).toBe(200);
    expect(resolved).toEqual([scope]);
    const request = seen.at(-1)!;
    expect(request.url).toBe("/page?x=1&y=two");
    expect(request.headers.host).toBe(new URL(upstreamOrigin).host);
    expect(request.headers.accept).toBe("text/html");
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.origin).toBeUndefined();
    expect(request.headers["x-forwarded-host"]).toBeUndefined();
  });

  it("redirects the bare capability to its trailing-slash document URL", async () => {
    const { app } = setup();
    const capability = sealed();
    const response = await call(app, `/api/preview/${capability}?a=1`);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/api/preview/${capability}/?a=1`);
  });

  it("refuses path traversal, double slashes and absolute URLs", async () => {
    const { app, resolved } = setup();
    const base = `/api/preview/${sealed()}`;
    for (const path of [
      "/a//b",
      "//evil.example/x",
      "/a%2fb",
      "/a%5c..",
      "/http:%2f%2fevil.example",
    ]) {
      const response = await call(app, `${base}${path}`);
      expect(response.status, path).toBe(400);
    }
    expect(resolved).toHaveLength(0);
    // The URL parser already resolves dot segments (also %2e%2e) before routing:
    // they can leave the capability prefix (then no preview route matches) but
    // never reach the bot's server.
    seen.length = 0;
    for (const path of ["/a/%2e%2e/b", "/a/../b", "/%2E%2E/%2e%2e/secret"]) {
      const response = await call(app, `${base}${path}`);
      expect([200, 404], path).toContain(response.status);
    }
    expect(seen.map((request) => request.url)).toEqual(["/b", "/b"]);
    expect(isSafePreviewPath("/a/b.c/d")).toBe(true);
    for (const path of ["/a/../b", "/./b", "/a/%2e%2e/b", "/%2E/b", "/a\\b", "/a%2fb", "a"])
      expect(isSafePreviewPath(path), path).toBe(false);
  });

  it("filters headers and sets its own frame policy", async () => {
    const { app } = setup();
    const response = await call(app, `${previewUrl(sealed())}index.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>ok GET /index.html</p>");
    const headers = response.headers;
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(headers.get("cache-control")).toBe("max-age=5");
    expect(headers.get("x-custom")).toBe("kept");
    expect(headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms; frame-ancestors 'self'",
    );
    expect(headers.get("access-control-allow-origin")).toBe("null");
    expect(headers.get("access-control-allow-credentials")).toBeNull();
    for (const name of [
      "set-cookie",
      "x-frame-options",
      "clear-site-data",
      "content-disposition",
      "refresh",
      "connection",
      "x-hop",
    ])
      expect(headers.get(name), name).toBeNull();
  });

  it("passes upstream error statuses through", async () => {
    const { app } = setup();
    const response = await call(app, `${previewUrl(sealed())}missing`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("nope");
  });

  it("forwards POST bodies up to 10 MB and refuses larger ones with 413", async () => {
    const { app } = setup();
    seen.length = 0;
    const ok = await call(app, `${previewUrl(sealed())}form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(ok.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: "a=1" });

    const tooLarge = await call(app, `${previewUrl(sealed())}form`, {
      method: "POST",
      body: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
  });

  it("answers 504 when the bot's server takes too long", async () => {
    const { app } = setup({ timeoutMs: 150 });
    const response = await call(app, `${previewUrl(sealed())}hang`);
    expect(response.status).toBe(504);
  });

  it("keeps redirects inside the capability and refuses foreign ones", async () => {
    const { app } = setup();
    const capability = sealed();
    const prefix = `/api/preview/${capability}`;
    const root = await call(app, `${prefix}/redirect-root`);
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(`${prefix}/login?next=1`);
    const relative = await call(app, `${prefix}/redirect-relative`);
    expect(relative.headers.get("location")).toBe("next/page");
    const self = await call(app, `${prefix}/redirect-self`);
    expect(self.status).toBe(301);
    expect(self.headers.get("location")).toBe(`${prefix}/home#top`);
    expect((await call(app, `${prefix}/redirect-evil`)).status).toBe(502);
    expect((await call(app, `${prefix}/redirect-scheme-relative`)).status).toBe(502);

    expect(rewriteLocation("javascript:alert(1)", prefix, 8080)).toBeNull();
    expect(rewriteLocation("http://user:pw@localhost:8080/", prefix, 8080)).toBeNull();
    expect(rewriteLocation("http://localhost:9090/", prefix, 8080)).toBeNull();
  });
});

describe("preview proxy: logging", () => {
  it("logs scope and path but never the sealed token or a response body", async () => {
    const { app, sink } = setup();
    const capability = sealed();
    const [, token] = capability.split(".") as [string, string];
    await call(app, `${previewUrl(capability)}index.html?q=1`);
    await call(app, `${previewUrl(capability)}missing`);
    await call(app, `${previewUrl(capability)}redirect-evil`);
    await call(app, previewUrl(capability), { cookie: null });
    const output = JSON.stringify(sink.events);
    expect(output).not.toContain(token);
    expect(output).not.toContain(capability);
    expect(output).not.toContain("<p>ok");
    expect(output).not.toContain("nope");
    const proxied = sink.events.find((event) => event.message === "preview.proxied");
    expect(JSON.stringify(proxied)).toContain('"preview.bot_id":"bot_a"');
    expect(JSON.stringify(proxied)).toContain('"preview.computer_id":"computer_a"');
    expect(JSON.stringify(proxied)).toContain('"preview.port":8080');
    expect(JSON.stringify(proxied)).toContain('"preview.path":"/index.html"');
  });
});

describe("prismaPreviewAccess", () => {
  function fakePrisma(bot: unknown, member: unknown) {
    return {
      bot: { findFirst: async () => bot },
      spaceMember: { findFirst: async () => member },
    } as unknown as PrismaClient;
  }
  const running = {
    spaceId: "space_a",
    screenGeneration: 2,
    computer: { screenGeneration: 5, state: "running", providerRef: "ref" },
  };

  it("checks membership, both generations and the running computer", async () => {
    const member = { userId: "user_member" };
    expect(await prismaPreviewAccess(fakePrisma(running, member))("u", scope)).toBe("ok");
    expect(await prismaPreviewAccess(fakePrisma(running, null))("u", scope)).toBe("forbidden");
    expect(await prismaPreviewAccess(fakePrisma(null, member))("u", scope)).toBe("expired");
    expect(
      await prismaPreviewAccess(fakePrisma({ ...running, screenGeneration: 3 }, member))(
        "u",
        scope,
      ),
    ).toBe("expired");
    expect(
      await prismaPreviewAccess(
        fakePrisma({ ...running, computer: { ...running.computer, screenGeneration: 6 } }, member),
      )("u", scope),
    ).toBe("expired");
    expect(
      await prismaPreviewAccess(
        fakePrisma({ ...running, computer: { ...running.computer, state: "stopped" } }, member),
      )("u", scope),
    ).toBe("unavailable");
  });

  it("does not open a capability for another port, bot, computer, or generation", async () => {
    // The scope is sealed: a capability for one port, bot or computer never
    // reaches another, because the proxy only ever uses the opened scope.
    const { app, resolved } = setup();
    for (const other of [{ port: 9090 }, { botId: "bot_b" }, { computerId: "computer_b" }]) {
      resolved.length = 0;
      await call(app, previewUrl(sealed(other)), { method: "HEAD" });
      expect(resolved).toEqual([{ ...scope, ...other }]);
    }
  });
});

describe("preview proxy: sandbox origin (AK 10)", () => {
  const SUBRESOURCE = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "script",
  };
  const SANDBOX_LINK = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "iframe",
  };
  const OWN_TAB = {
    "sec-fetch-site": "none",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };

  it("serves a subresource with a valid capability but no session (200)", async () => {
    const seen: (string | null)[] = [];
    const { app } = setup({
      checkAccess: async (userId) => {
        seen.push(userId);
        return "ok";
      },
    });
    const response = await call(app, previewUrl(sealed()), { cookie: null, headers: SUBRESOURCE });
    expect(response.status).toBe(200);
    expect(seen).toEqual([null]);
    const frame = await call(app, previewUrl(sealed()), { cookie: null, headers: SANDBOX_LINK });
    expect(frame.status).toBe(200);
  });

  it("still requires the session for Johann's own navigation and for requests without fetch metadata", async () => {
    const { app, resolved } = setup();
    for (const headers of [OWN_TAB, { ...OWN_TAB, "sec-fetch-site": "same-origin" }, {}]) {
      const response = await call(app, previewUrl(sealed()), { cookie: null, headers });
      expect(response.status).toBe(401);
    }
    expect(resolved).toHaveLength(0);
  });

  it("checks membership whenever a session is present, also for subresources", async () => {
    const { app } = setup({ access: "forbidden" });
    const response = await call(app, previewUrl(sealed()), { headers: SUBRESOURCE });
    expect(response.status).toBe(403);
  });

  it("answers 410 for an expired capability on a subresource", async () => {
    const { app } = setup();
    const old = sealed({}, Date.now() - 2 * 60 * 60 * 1000);
    const response = await call(app, previewUrl(old), { cookie: null, headers: SUBRESOURCE });
    expect(response.status).toBe(410);
  });

  it("puts the sandbox CSP on every response, errors and redirects included", async () => {
    const { app } = setup();
    const url = previewUrl(sealed());
    const responses = [
      await call(app, url),
      await call(app, url, { cookie: null }),
      await call(app, url, { method: "PUT" }),
      await call(app, url.replace(/\/$/, "")),
      await call(app, `${url}redirect-root`),
      await call(app, previewUrl(sealed({}, Date.now() - 2 * 60 * 60 * 1000))),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 401, 405, 308, 302, 410]);
    for (const response of responses)
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts allow-forms; frame-ancestors 'self'",
      );
  });
});

describe("preview proxy: supervisor upstream", () => {
  function prismaWith(computer: Record<string, unknown> | null) {
    return {
      bot: { findFirst: async () => (computer ? { computer } : null) },
    } as unknown as PrismaClient;
  }

  it("goes through the supervisor relay with the computer's identity from the database", async () => {
    const resolve = supervisorPreviewUpstream(
      prismaWith({ kind: "docker", providerRef: "ctr 1", homeKey: "home_a", spaceId: "space_a" }),
      "http://supervisor:7091/",
      "sup-token",
    );
    expect(await resolve(scope)).toEqual({
      base: "http://supervisor:7091/computers/ctr%201/http/8080",
      headers: {
        authorization: "Bearer sup-token",
        "x-rakazo-bot-id": "home_a",
        "x-rakazo-space-id": "space_a",
      },
    });
  });

  it("has no upstream for missing, stopped or non-docker computers", async () => {
    for (const computer of [
      null,
      { kind: "docker", providerRef: null, homeKey: "h", spaceId: "s" },
      { kind: "e2b", providerRef: "x", homeKey: "h", spaceId: "s" },
    ]) {
      const resolve = supervisorPreviewUpstream(prismaWith(computer), "http://sup", "t");
      expect(await resolve(scope)).toBeNull();
    }
  });
});

describe("preview artifact read (AK 6)", () => {
  const storedPreview = {
    title: "App",
    port: 8080,
    path: "/app/",
    botId: scope.botId,
    computerId: scope.computerId,
    description: null,
  };
  const artifact = {
    id: "art-1",
    mimeType: PREVIEW_ARTIFACT_MIME_TYPE,
    contentBase64: Buffer.from(JSON.stringify(storedPreview)).toString("base64"),
  };
  function prismaWithBot(bot: Record<string, unknown> | null) {
    const findFirst = async () => bot;
    return { bot: { findFirst } } as unknown as PrismaClient;
  }
  const decode = (value: { contentBase64: string }) =>
    JSON.parse(Buffer.from(value.contentBase64, "base64").toString("utf8"));

  it("seals a fresh url on every read and the proxy accepts it", async () => {
    const prisma = prismaWithBot({
      screenGeneration: scope.botGeneration,
      computer: { screenGeneration: scope.computerGeneration },
    });
    const now = Date.now();
    const first = decode(await withSealedPreview(prisma, secret, artifact, now));
    const second = decode(await withSealedPreview(prisma, secret, artifact, now + 1_000));
    expect(first).toMatchObject({ ...storedPreview });
    expect(first.url).toMatch(/^\/api\/preview\/[^/]+\/app\/$/);
    expect(first.url).not.toBe(second.url);
    expect(Date.parse(first.expiresAt) - now).toBe(60 * 60 * 1000);
    const { app } = setup();
    const response = await call(app, first.url.replace(/app\/$/, ""));
    expect(response.status).toBe(200);
  });

  it("returns url null when the bot is gone or on another computer", async () => {
    const view = decode(await withSealedPreview(prismaWithBot(null), secret, artifact));
    expect(view).toMatchObject({ ...storedPreview, url: null, expiresAt: null });
  });

  it("leaves other artifacts untouched and refuses a damaged preview", async () => {
    const other = { mimeType: "text/html", contentBase64: "PGgxPg==" };
    expect(await withSealedPreview(prismaWithBot(null), secret, other)).toBe(other);
    await expect(
      withSealedPreview(prismaWithBot(null), secret, { ...artifact, contentBase64: "e30=" }),
    ).rejects.toThrow();
  });
});
