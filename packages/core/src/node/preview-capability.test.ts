import { describe, expect, it } from "vitest";
import {
  openPreviewCapability,
  PREVIEW_PROXY_TTL_MS,
  type PreviewCapabilityScope,
  previewUrl,
  sealPreviewCapability,
} from "./preview-capability.js";
import { openScreenCapability, sealScreenCapability } from "./screen-capability.js";

const secret = "test-screen-proxy-secret-0123456789abcdef";
const now = 1_800_000_000_000;
const scope: PreviewCapabilityScope = {
  botId: "bot_a",
  computerId: "computer_a",
  botGeneration: 3,
  computerGeneration: 7,
  port: 8080,
};

describe("preview capability", () => {
  it("round-trips the full scope and expires after 10 minutes", () => {
    const { sealed, expiresAt } = sealPreviewCapability(secret, scope, now);
    expect(expiresAt).toBe(now + PREVIEW_PROXY_TTL_MS);
    expect(PREVIEW_PROXY_TTL_MS).toBe(10 * 60_000);
    expect(previewUrl(sealed)).toBe(`/api/preview/${sealed}/`);
    expect(openPreviewCapability(sealed, secret, now)).toEqual({ ok: true, scope, expiresAt });
    expect(openPreviewCapability(sealed, secret, expiresAt)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("does not leak the scope into the sealed segment", () => {
    const { sealed } = sealPreviewCapability(secret, scope, now);
    expect(sealed).not.toContain("bot_a");
    expect(sealed).not.toContain("computer_a");
    expect(sealed).not.toContain("8080");
  });

  it("refuses ports outside 1024-65535 when sealing", () => {
    for (const port of [0, 80, 1023, 65536, 8080.5])
      expect(() => sealPreviewCapability(secret, { ...scope, port }, now)).toThrow();
  });

  it("rejects a forged expiry, a flipped byte, a wrong secret, and garbage as invalid", () => {
    const { sealed, expiresAt } = sealPreviewCapability(secret, scope, now);
    const [, token] = sealed.split(".") as [string, string];
    const forgedExpiry = `${expiresAt + PREVIEW_PROXY_TTL_MS}.${token}`;
    expect(openPreviewCapability(forgedExpiry, secret, now)).toEqual({
      ok: false,
      reason: "invalid",
    });
    // A forged *past* expiry must not become a 410 either.
    expect(openPreviewCapability(`${now - 1}.${token}`, secret, now)).toEqual({
      ok: false,
      reason: "invalid",
    });
    const bytes = Buffer.from(token, "base64url");
    for (const index of [0, 13, 30, bytes.length - 1]) {
      const flipped = Buffer.from(bytes);
      flipped[index] = flipped[index]! ^ 0x01;
      expect(
        openPreviewCapability(`${expiresAt}.${flipped.toString("base64url")}`, secret, now),
      ).toEqual({ ok: false, reason: "invalid" });
    }
    expect(openPreviewCapability(sealed, `${secret}x`, now).ok).toBe(false);
    expect(openPreviewCapability(sealed, "", now).ok).toBe(false);
    for (const bad of [undefined, "", "abc", `${expiresAt}.`, `${expiresAt}.${token}/x`])
      expect(openPreviewCapability(bad, secret, now)).toEqual({ ok: false, reason: "invalid" });
  });

  it("keeps preview and screen seals apart", () => {
    const screen = new URL(
      sealScreenCapability(
        "http://rakazo-bot-x:6080/vnc.html",
        secret,
        "https://app.example.test",
        {
          botId: "bot_a",
          computerId: "computer_a",
          botGeneration: 3,
          computerGeneration: 7,
          controlLeaseId: null,
        },
        now,
      ),
    );
    const screenSegment = screen.pathname.split("/")[4]!;
    expect(openPreviewCapability(screenSegment, secret, now).ok).toBe(false);

    const { sealed } = sealPreviewCapability(secret, scope, now);
    expect(openScreenCapability(`/novnc/session/view/${sealed}/`, secret, now)).toBeNull();
  });
});
