import type { ArtifactStore } from "@rakazo/adapter-kit";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { PREVIEW_ARTIFACT_MIME_TYPE, parseStoredPreview } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { attachPreviewToThread } from "./thread-artifacts.js";

function fakeDeps(existing: { id: string; rootArtifactId: string | null; version: number } | null) {
  const stored: Uint8Array[] = [];
  const created: Record<string, unknown>[] = [];
  const artifact = {
    findFirst: vi.fn().mockResolvedValue(existing),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return { id: `art-${created.length}`, ...data };
    }),
  };
  const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([{ lock: "1" }]) };
  const deps = {
    prisma: {
      artifact,
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as PrismaClient,
    artifacts: {
      put: vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
        stored.push(bytes);
        return { id: `stored-${stored.length}`, hash: "h" };
      }),
      remove: vi.fn(),
    } as unknown as ArtifactStore,
  };
  return { deps, stored, created };
}

const base = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  operationId: "op-1",
  computerId: "computer-1",
};

describe("expose_preview (AK 1)", () => {
  it("creates a preview artifact with the stored fields and no token", async () => {
    const { deps, stored, created } = fakeDeps(null);
    const result = await attachPreviewToThread(deps, {
      ...base,
      port: 5173,
      title: "  Weide-App  ",
      path: "app/",
      description: "Stand ASK-92",
    });
    expect(result.block).toMatchObject({
      kind: "file",
      artifactId: "art-1",
      mimeType: PREVIEW_ARTIFACT_MIME_TYPE,
      name: "Weide-App",
    });
    expect(created[0]).toMatchObject({ mimeType: PREVIEW_ARTIFACT_MIME_TYPE, version: 1 });
    const content = new TextDecoder().decode(stored[0]);
    expect(JSON.parse(content)).toEqual({
      title: "Weide-App",
      port: 5173,
      path: "/app/",
      botId: "bot-1",
      computerId: "computer-1",
      description: "Stand ASK-92",
    });
    expect(content).not.toMatch(/sealed|token|url|api\/preview/i);
    expect(parseStoredPreview(stored[0] as Uint8Array)).not.toBeNull();
  });

  it("defaults path to / and description to null", async () => {
    const { deps, stored } = fakeDeps(null);
    await attachPreviewToThread(deps, { ...base, port: 3000, title: "x" });
    expect(JSON.parse(new TextDecoder().decode(stored[0]))).toMatchObject({
      path: "/",
      description: null,
    });
  });

  it("makes a new version for the same title", async () => {
    const { deps, created } = fakeDeps({ id: "art-0", rootArtifactId: null, version: 1 });
    await attachPreviewToThread(deps, { ...base, port: 3000, title: "x" });
    expect(created[0]).toMatchObject({ version: 2, rootArtifactId: "art-0" });
  });

  it("rejects bad ports, reserved ports, missing titles and unsafe paths without storing anything", async () => {
    const cases: Record<string, unknown>[] = [
      { port: 80, title: "x" },
      { port: 1023, title: "x" },
      { port: 65536, title: "x" },
      { port: 3000.5, title: "x" },
      { port: "3000", title: "x" },
      { port: 6080, title: "x" },
      { port: 7070, title: "x" },
      { port: 5900, title: "x" },
      { port: 9222, title: "x" },
      { port: 3000, title: "" },
      { port: 3000, title: "   " },
      { port: 3000 },
      { port: 3000, title: "x", path: "../etc" },
      { port: 3000, title: "x", path: "/a/%2e%2e/b" },
      { port: 3000, title: "x", path: "/a?b=1" },
      { port: 3000, title: "x", path: "//evil" },
      { port: 3000, title: "x", path: 5 },
      { port: 3000, title: "x", description: 5 },
    ];
    for (const input of cases) {
      const { deps, stored } = fakeDeps(null);
      await expect(
        attachPreviewToThread(deps, { ...base, ...input } as Parameters<
          typeof attachPreviewToThread
        >[1]),
        JSON.stringify(input),
      ).rejects.toThrow();
      expect(stored).toHaveLength(0);
    }
  });
});

describe("expose_preview catalog entry (AK 8)", () => {
  it("is a builtin tool and names its limits", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("expose_preview");
    const tool = builtinAgentTools.find((entry) => entry.name === "expose_preview");
    expect(tool).toBeDefined();
    const text = tool?.description ?? "";
    expect(text).toMatch(/HTTP/);
    expect(text).toMatch(/no WebSockets/);
    expect(text).toMatch(/while the computer and the server run/);
    expect(text).toMatch(/screenshots/);
    expect(text).toMatch(/no localStorage/);
    expect(text).toMatch(/cookies set by the preview server are dropped/);
    expect(tool?.inputSchema).toMatchObject({ required: ["port", "title"] });
  });
});
