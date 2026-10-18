import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  isBuiltinToolName,
  type ThinkingLevel,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import { resolveBotAddress } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { validateConnectedModelChoice } from "./model-selection.js";

type Scope = { spaceId: string; userId: string };
type ReadText = (path: string) => Promise<{ content: string } | { error: string }>;

export type BotModelChoice = {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

/** Tools a bot keeps so it can always change itself back. */
const ALWAYS_ON_TOOLS = new Set(["update_bot", "read_bot"]);

const SETUP_FIELDS = {
  id: true,
  name: true,
  title: true,
  instructions: true,
  parentBotId: true,
  modelProvider: true,
  modelId: true,
  thinkingLevel: true,
  disabledBuiltinTools: true,
  mcpServers: { select: { server: { select: { name: true } } } },
} as const;

type SetupBot = Prisma.BotGetPayload<{ select: typeof SETUP_FIELDS }>;

/**
 * The bot a call targets: the caller without `bot`, otherwise any active bot in the space by
 * id or name. Bots the user created change every bot; a bot another bot created changes
 * itself and the bots it created.
 */
export async function findBotToChange(
  prisma: PrismaClient,
  scope: Scope,
  caller: { id: string; parentBotId: string | null },
  target: unknown,
  access: "read" | "change",
) {
  const address = typeof target === "string" ? target.trim() : "";
  const bots = await prisma.bot.findMany({
    where: { spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
    select: SETUP_FIELDS,
  });
  const bot = address
    ? (bots.find((candidate) => candidate.id === address) ??
      resolveBotAddress(bots, { name: address }))
    : bots.find((candidate) => candidate.id === caller.id);
  if (!bot) return { error: `No active bot called "${address}".` };
  const allowed =
    bot.id === caller.id || caller.parentBotId === null || bot.parentBotId === caller.id;
  if (access === "change" && !allowed) {
    return {
      error: `You can change yourself and the bots you created, not ${bot.name}. Ask the bot that leads the team.`,
    };
  }
  return { bot, canChange: allowed };
}

/** Everything that makes up a bot, for read_bot and as the result of update_bot. */
export async function describeBotSetup(prisma: PrismaClient, scope: Scope, bot: SetupBot) {
  const [parent, servers] = await Promise.all([
    bot.parentBotId
      ? prisma.bot.findUnique({ where: { id: bot.parentBotId }, select: { name: true } })
      : null,
    prisma.mcpServer.findMany({
      where: { spaceId: scope.spaceId, userId: scope.userId, enabled: true },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return {
    botId: bot.id,
    name: bot.name,
    title: bot.title,
    createdBy: parent?.name ?? "the user",
    model: bot.modelId ? `${bot.modelProvider}/${bot.modelId}` : "space default",
    thinkingLevel: bot.thinkingLevel ?? "default",
    disabledTools: bot.disabledBuiltinTools,
    mcpServers: bot.mcpServers.map((assignment) => assignment.server.name),
    availableMcpServers: servers.map((server) => server.name),
    instructionCharacters: bot.instructions.length,
    instructions: bot.instructions,
  };
}

/** Reads model_provider, model_id, and thinking_level; omitted fields stay as they are. */
export async function parseBotModel(
  prisma: PrismaClient,
  scope: Scope,
  args: Record<string, unknown>,
): Promise<{ model: BotModelChoice } | { error: string }> {
  const provider = optionalText(args.model_provider);
  const modelId = optionalText(args.model_id);
  const thinkingLevel = optionalText(args.thinking_level);
  if (Boolean(provider) !== Boolean(modelId)) {
    return { error: "Pass model_provider and model_id together." };
  }
  const model: BotModelChoice = {};
  if (provider && modelId) {
    const error = await validateConnectedModelChoice(prisma, scope, provider, modelId);
    if (error) return { error };
    model.modelProvider = provider;
    model.modelId = modelId;
  }
  if (thinkingLevel) {
    const level = ThinkingLevelSchema.safeParse(thinkingLevel);
    if (!level.success) {
      return { error: `thinking_level must be one of ${ThinkingLevelSchema.options.join(", ")}.` };
    }
    model.thinkingLevel = level.data;
  }
  return { model };
}

/**
 * The instructions a call asks for, or none when it leaves them alone. A file is read from
 * the caller's computer and stored exactly, so a long text never passes through the model
 * again. Edits and an appended paragraph apply after any replacement.
 */
export async function nextInstructions(
  current: string,
  args: Record<string, unknown>,
  readText: ReadText,
): Promise<{ instructions?: string } | { error: string }> {
  // The app shows one field for both, so description means the same text.
  const inline = optionalText(args.instructions) ?? optionalText(args.description);
  const file = optionalText(args.instructions_file);
  const edits = Array.isArray(args.instructions_edits) ? args.instructions_edits : [];
  const append = optionalText(args.instructions_append);
  if (inline && file) return { error: "Pass instructions or instructions_file, not both." };
  if (!inline && !file && edits.length === 0 && !append) return {};

  let text = inline ?? current;
  if (file) {
    const read = await readText(file);
    if ("error" in read) return { error: `instructions_file ${file}: ${read.error}` };
    text = read.content.trim();
    if (!text) return { error: `instructions_file ${file} is empty.` };
  }
  for (const [index, edit] of edits.entries()) {
    const old = typeof edit?.old === "string" ? edit.old : "";
    const replacement = typeof edit?.new === "string" ? edit.new : "";
    const count = old ? text.split(old).length - 1 : 0;
    if (count !== 1) {
      return {
        error: `instructions_edits[${index}].old must appear exactly once in the instructions; it appears ${count} times. Call read_bot and copy the text exactly.`,
      };
    }
    text = text.replace(old, () => replacement);
  }
  if (append) text = text ? `${text}\n\n${append}` : append;
  text = text.trim();
  if (text.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    return {
      error: `Instructions would have ${text.length} characters; the limit is ${BOT_INSTRUCTIONS_MAX_LENGTH}.`,
    };
  }
  return { instructions: text };
}

/** The disabled built-in tools after enable_tools and disable_tools. */
export function nextDisabledTools(
  current: string[],
  args: Record<string, unknown>,
): { disabledBuiltinTools?: string[] } | { error: string } {
  const enable = textList(args.enable_tools);
  const disable = textList(args.disable_tools);
  if (enable.length === 0 && disable.length === 0) return {};
  const unknown = [...enable, ...disable].filter((name) => !isBuiltinToolName(name));
  if (unknown.length) return { error: `Unknown built-in tools: ${unknown.join(", ")}.` };
  const locked = disable.filter((name) => ALWAYS_ON_TOOLS.has(name));
  if (locked.length) return { error: `${locked.join(", ")} cannot be disabled by a bot.` };
  const next = new Set(current);
  for (const name of disable) next.add(name);
  for (const name of enable) next.delete(name);
  return { disabledBuiltinTools: [...next] };
}

/** MCP server ids to assign and unassign, looked up by name. */
export async function nextMcpServers(
  prisma: PrismaClient,
  scope: Scope,
  args: Record<string, unknown>,
): Promise<{ add: string[]; remove: string[] } | { error: string }> {
  const add = textList(args.add_mcp_servers);
  const remove = textList(args.remove_mcp_servers);
  if (add.length === 0 && remove.length === 0) return { add: [], remove: [] };
  const servers = await prisma.mcpServer.findMany({
    where: { spaceId: scope.spaceId, userId: scope.userId },
    select: { id: true, name: true, slug: true, enabled: true },
  });
  const find = (name: string) =>
    servers.find(
      (server) =>
        server.name.toLowerCase() === name.toLowerCase() ||
        server.slug.toLowerCase() === name.toLowerCase(),
    );
  const missing = [...add, ...remove].filter((name) => !find(name));
  if (missing.length) {
    const known = servers.map((server) => server.name).join(", ") || "none";
    return { error: `Unknown MCP servers: ${missing.join(", ")}. Available: ${known}.` };
  }
  const disabled = add.filter((name) => !find(name)?.enabled);
  if (disabled.length)
    return { error: `MCP servers turned off by the user: ${disabled.join(", ")}.` };
  return {
    add: add.map((name) => find(name)!.id),
    remove: remove.map((name) => find(name)!.id),
  };
}

/** Save instructions, model, tools, and MCP servers in one transaction. */
export async function saveBotSetup(
  prisma: PrismaClient,
  scope: Scope,
  botId: string,
  change: {
    instructions?: string;
    model: BotModelChoice;
    disabledBuiltinTools?: string[];
    profile: Record<string, unknown>;
    mcp: { add: string[]; remove: string[] };
  },
) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.bot.update({
      where: { id: botId },
      data: {
        ...change.profile,
        ...change.model,
        ...(change.instructions === undefined
          ? {}
          : {
              instructions: change.instructions,
              description: change.instructions.slice(0, BOT_DESCRIPTION_MAX_LENGTH),
            }),
        ...(change.disabledBuiltinTools
          ? { disabledBuiltinTools: change.disabledBuiltinTools }
          : {}),
      },
      select: { id: true, name: true, title: true, description: true },
    });
    if (change.mcp.remove.length) {
      await tx.botMcpServer.deleteMany({
        where: { botId, serverId: { in: change.mcp.remove } },
      });
    }
    for (const serverId of change.mcp.add) {
      await tx.botMcpServer.upsert({
        where: { botId_serverId: { botId, serverId } },
        create: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId,
          serverId,
          allowAllTools: true,
          allowedTools: [],
        },
        update: {},
      });
    }
    return updated;
  });
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}
