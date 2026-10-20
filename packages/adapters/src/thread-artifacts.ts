import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode, MessageBlock } from "@rakazo/contracts";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
} from "@rakazo/contracts";
import {
  attachmentExtensionForMimeType,
  encodeStoredPreview,
  inferAttachmentMimeType,
  isAllowedPreviewPort,
  messageBlockForArtifact,
  normalizePreviewPath,
  PREVIEW_ARTIFACT_MIME_TYPE,
  PREVIEW_DESCRIPTION_MAX_LENGTH,
  PREVIEW_TITLE_MAX_LENGTH,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { withResolvedArtifactVersion } from "@rakazo/db";
import { resolveBotWorkspacePath } from "./computer-support.js";

export type MaterializedThreadFile = {
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

export async function attachWorkspaceFileToThread(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string;
    runId: string;
    filePath: string;
    bytes: Uint8Array;
    operationId: string;
    name?: string;
    description?: string;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const fileName = path.basename(input.filePath) || input.filePath;
  const mimeType = inferAttachmentMimeType(fileName);
  if (!mimeType) {
    throw new Error(`Unsupported attachment type for ${fileName}`);
  }
  const name = (input.name?.trim() || fileName).slice(0, ARTIFACT_NAME_MAX_LENGTH);
  validateAttachmentMimeType(mimeType);
  if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error("file exceeds the 10 MiB attachment limit");
  }
  return storeThreadArtifact(deps, { ...input, name, mimeType });
}

type ThreadArtifactInput = {
  spaceId: string;
  userId: string;
  botId: string;
  groupId?: string;
  runId: string;
  operationId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  description?: string;
};

/** Stores the bytes, versions the row by name (withResolvedArtifactVersion) and returns the message block. */
async function storeThreadArtifact(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  input: ThreadArtifactInput,
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const { name, mimeType } = input;
  const context = {
    operationId: input.operationId,
    traceId: input.operationId,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
  const stored = await deps.artifacts.put({ name, mimeType, bytes: input.bytes }, context);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const row = await withResolvedArtifactVersion(
    deps.prisma,
    {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      groupId: input.groupId,
      name,
    },
    (tx, { rootArtifactId, version }) =>
      tx.artifact.create({
        data: {
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          groupId: input.groupId,
          runId: input.runId,
          name,
          description: input.description?.trim().slice(0, ARTIFACT_DESCRIPTION_MAX_LENGTH) || null,
          mimeType,
          size: input.bytes.byteLength,
          hash,
          storageKey: stored.id,
          rootArtifactId,
          version,
        },
      }),
  ).catch(async (error) => {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  });
  return {
    artifactId: row.id,
    block: messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  };
}

/**
 * expose_preview (PIV-32): a normal artifact row with the preview media type.
 * Only this tool creates it; uploads keep their own allow-list. The stored
 * JSON names bot, computer and port, never a token.
 */
export async function attachPreviewToThread(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  input: Omit<ThreadArtifactInput, "name" | "mimeType" | "bytes" | "description"> & {
    computerId: string;
    port: unknown;
    title: unknown;
    path?: unknown;
    description?: unknown;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  if (!isAllowedPreviewPort(input.port)) {
    throw new Error(
      "port must be an integer from 1024 to 65535 and not one of the computer's own screen or control ports",
    );
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("title is required");
  const path = normalizePreviewPath(input.path);
  if (path === null)
    throw new Error("path must be a plain path inside the server, without .. or query");
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new Error("description must be a string");
  }
  const name = title.slice(0, Math.min(PREVIEW_TITLE_MAX_LENGTH, ARTIFACT_NAME_MAX_LENGTH));
  const description =
    (input.description as string | undefined)?.trim().slice(0, PREVIEW_DESCRIPTION_MAX_LENGTH) ||
    null;
  const bytes = encodeStoredPreview({
    title: name,
    port: input.port,
    path,
    botId: input.botId,
    computerId: input.computerId,
    description,
  });
  return storeThreadArtifact(deps, {
    ...input,
    name,
    mimeType: PREVIEW_ARTIFACT_MIME_TYPE,
    bytes,
    description: description ?? undefined,
  });
}

export async function materializeCurrentTurnFiles(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    sandbox: SandboxProvider;
  },
  blocks: MessageBlock[] | undefined,
  input: {
    context: AdapterContext & { botId: string };
    computer: ComputerRef;
    computerMode: ComputerMode;
    markWorkspaceDirty?: () => void;
  },
): Promise<MaterializedThreadFile[]> {
  // "image" attachments (e.g. a photo pasted or uploaded in chat) are backed
  // by a real artifact exactly like "file" ones — the model seeing them
  // inline for vision (loadCurrentTurnImages) doesn't put them on disk, so
  // they must be included here too or a bot can describe a photo it can't
  // actually attach, forward, or hand to a tool that needs the file.
  const fileBlocks = blocks?.filter(
    (block): block is Extract<MessageBlock, { kind: "file" | "image" }> =>
      block.kind === "file" || block.kind === "image",
  );
  if (!fileBlocks?.length) return [];

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: fileBlocks.map((block) => block.artifactId) },
      spaceId: input.context.spaceId,
      userId: input.context.userId,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const materialized: MaterializedThreadFile[] = [];

  for (const block of fileBlocks) {
    const row = byId.get(block.artifactId);
    if (!row) throw new Error(`Attached file is unavailable: ${block.name}`);
    const bytes = await deps.artifacts.get(row.storageKey, input.context);
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new Error(`Attached file exceeds the 10 MiB limit: ${row.name}`);
    }
    const relativePath = `attachments/${row.id}${attachmentExtensionForMimeType(row.mimeType)}`;
    input.markWorkspaceDirty?.();
    await deps.sandbox.writeFile(
      input.computer,
      {
        path: resolveBotWorkspacePath(input.computerMode, input.context.botId, relativePath),
        content: bytes,
      },
      input.context,
    );
    materialized.push({
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      path: relativePath,
    });
  }

  return materialized;
}

export function currentTurnFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Current-turn attached files are available on your computer. Inspect them before answering:",
    ...files.map(
      (file) =>
        `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${JSON.stringify(file.path)}`,
    ),
  ].join("\n");
}
