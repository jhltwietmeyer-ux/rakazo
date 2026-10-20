import { describe, expect, it } from "vitest";
import {
  encodeStoredPreview,
  isAllowedPreviewPort,
  normalizePreviewPath,
  parseStoredPreview,
  previewArtifactUrl,
} from "./preview-artifact.js";

const stored = {
  title: "App",
  port: 5173,
  path: "/app/",
  botId: "bot-1",
  computerId: "computer-1",
  description: null,
};

describe("preview artifact", () => {
  it("allows development ports and refuses the computer's own ports", () => {
    for (const port of [1024, 3000, 5173, 6079, 6096, 8080, 65535])
      expect(isAllowedPreviewPort(port)).toBe(true);
    for (const port of [
      0,
      80,
      1023,
      5900,
      5999,
      6080,
      6095,
      7070,
      9222,
      9299,
      65536,
      3000.5,
      "3000",
      null,
    ])
      expect(isAllowedPreviewPort(port), String(port)).toBe(false);
  });

  it("normalizes paths and refuses escapes, queries and encoded separators", () => {
    expect(normalizePreviewPath(undefined)).toBe("/");
    expect(normalizePreviewPath("")).toBe("/");
    expect(normalizePreviewPath("app/")).toBe("/app/");
    expect(normalizePreviewPath("/a/b.c")).toBe("/a/b.c");
    for (const bad of [
      "../x",
      "/a/../b",
      "/a/%2e%2e/b",
      "/a%2fb",
      "//host",
      "/a\\b",
      "/a?x=1",
      "/a#x",
      "/a\nb",
      5,
    ])
      expect(normalizePreviewPath(bad), String(bad)).toBeNull();
  });

  it("round-trips the stored form and rejects anything else", () => {
    expect(parseStoredPreview(encodeStoredPreview(stored))).toEqual(stored);
    const bad = [
      "not json",
      "[]",
      JSON.stringify({ ...stored, port: 6080 }),
      JSON.stringify({ ...stored, path: "/../x" }),
      JSON.stringify({ ...stored, title: "" }),
      JSON.stringify({ ...stored, description: 3 }),
      JSON.stringify({ ...stored, botId: "" }),
    ];
    for (const text of bad)
      expect(parseStoredPreview(new TextEncoder().encode(text)), text).toBeNull();
  });

  it("builds the url from the sealed prefix and the path without its leading slash", () => {
    expect(previewArtifactUrl("/api/preview/1.abc/", "/")).toBe("/api/preview/1.abc/");
    expect(previewArtifactUrl("/api/preview/1.abc/", "/app/")).toBe("/api/preview/1.abc/app/");
  });
});
