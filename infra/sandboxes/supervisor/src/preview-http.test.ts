import { resolveSupervisorToken } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { supervisorApp, supervisorRequestBodyLimit } from "./index.js";
import {
  PREVIEW_HTTP_MAX_BYTES,
  PreviewIdentityError,
  previewPortAllowed,
  relayPreviewHttp,
} from "./preview-http.js";

const token = resolveSupervisorToken(process.env);
const identity = { "x-rakazo-bot-id": "bot-1", "x-rakazo-space-id": "space-1" };

function fakeUpstream() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response("<h1>ok</h1>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "set-cookie": "a=1",
        connection: "close",
        location: "/next",
      },
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const lookupHost = async (id: string, botId?: string, spaceId?: string) => {
  if (id !== "c1" || botId !== "bot-1" || spaceId !== "space-1")
    throw new PreviewIdentityError("computer identity mismatch");
  return "172.20.0.5";
};

describe("PIV-32 supervisor preview relay (AK 9)", () => {
  it("answers 401 without the supervisor token, before touching Docker", async () => {
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = await supervisorApp.request("/computers/c1/http/3000/", {
        method,
        headers: identity,
      });
      expect(response.status, method).toBe(401);
    }
  });

  it("answers 403 for port 6080, control ports and ports below 1024, before touching Docker", async () => {
    for (const port of ["6080", "6085", "7070", "5900", "9222", "80", "1023", "0", "65536", "03000"]) {
      const response = await supervisorApp.request(`/computers/c1/http/${port}/`, {
        headers: { authorization: `Bearer ${token}`, ...identity },
      });
      expect(response.status, port).toBe(403);
    }
  });

  it("answers 403 for a foreign bot or space id", async () => {
    const { calls, fetch } = fakeUpstream();
    for (const headers of [
      { "x-rakazo-bot-id": "bot-2", "x-rakazo-space-id": "space-1" },
      { "x-rakazo-bot-id": "bot-1", "x-rakazo-space-id": "space-2" },
      {},
    ]) {
      const response = await relayPreviewHttp(
        new Request("http://sup/computers/c1/http/3000/", { headers }),
        { lookupHost, fetch },
      );
      expect(response.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("relays to the container address without following redirects or passing cookies", async () => {
    const { calls, fetch } = fakeUpstream();
    const response = await relayPreviewHttp(
      new Request("http://sup/computers/c1/http/5173/assets/app.js?v=1", {
        headers: { ...identity, cookie: "session=x", authorization: "Bearer y", accept: "*/*" },
      }),
      { lookupHost, fetch },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>ok</h1>");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBe("/next");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://172.20.0.5:5173/assets/app.js?v=1");
    expect(calls[0]?.init.redirect).toBe("manual");
    const sent = new Headers(calls[0]?.init.headers);
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("accept")).toBe("*/*");
  });

  it("refuses other methods and oversized bodies", async () => {
    const { fetch } = fakeUpstream();
    const put = await relayPreviewHttp(
      new Request("http://sup/computers/c1/http/3000/", { method: "PUT", headers: identity }),
      { lookupHost, fetch },
    );
    expect(put.status).toBe(405);
    expect(supervisorRequestBodyLimit("POST", "/computers/c1/http/3000/form")).toBe(
      PREVIEW_HTTP_MAX_BYTES,
    );
    const big = await relayPreviewHttp(
      new Request("http://sup/computers/c1/http/3000/", {
        method: "POST",
        headers: identity,
        body: new Uint8Array(PREVIEW_HTTP_MAX_BYTES + 1),
      }),
      { lookupHost, fetch },
    );
    expect(big.status).toBe(413);
  });

  it("maps an unreachable server to 502 and a slow one to 504", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const r1 = await relayPreviewHttp(
      new Request("http://sup/computers/c1/http/3000/", { headers: identity }),
      { lookupHost, fetch: refused },
    );
    expect(r1.status).toBe(502);
    const slow = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const r2 = await relayPreviewHttp(
      new Request("http://sup/computers/c1/http/3000/", { headers: identity }),
      { lookupHost, fetch: slow, timeoutMs: 20 },
    );
    expect(r2.status).toBe(504);
  });

  it("allows ordinary development ports", () => {
    expect(previewPortAllowed("3000")).toBe(3000);
    expect(previewPortAllowed("5173")).toBe(5173);
    expect(previewPortAllowed("65535")).toBe(65535);
    expect(previewPortAllowed("6079")).toBe(6079);
  });
});
