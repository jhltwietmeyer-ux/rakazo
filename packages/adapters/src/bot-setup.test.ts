import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  findBotToChange,
  nextDisabledTools,
  nextInstructions,
  nextMcpServers,
  parseBotModel,
  saveBotSetup,
} from "./bot-setup.js";
import type * as modelSelection from "./model-selection.js";
import { validateConnectedModelChoice } from "./model-selection.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof modelSelection>()),
  validateConnectedModelChoice: vi.fn().mockResolvedValue(undefined),
}));

const scope = { spaceId: "space-1", userId: "user-1" };

function bot(id: string, name: string, parentBotId: string | null) {
  return {
    id,
    name,
    title: "",
    instructions: `${name} rules.`,
    parentBotId,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    disabledBuiltinTools: [],
    mcpServers: [],
  };
}

const team = [
  bot("lead", "Chief", null),
  bot("cto", "Architect", "lead"),
  bot("dev", "Builder", "cto"),
  bot("mail", "Courier", "lead"),
];

function prismaWithTeam() {
  return { bot: { findMany: vi.fn().mockResolvedValue(team) } } as unknown as PrismaClient;
}

describe("findBotToChange", () => {
  it("lets a bot the user created change every bot", async () => {
    const prisma = prismaWithTeam();
    const lead = { id: "lead", parentBotId: null };

    await expect(findBotToChange(prisma, scope, lead, undefined, "change")).resolves.toMatchObject({
      bot: { id: "lead" },
    });
    await expect(findBotToChange(prisma, scope, lead, "builder", "change")).resolves.toMatchObject({
      bot: { id: "dev" },
      canChange: true,
    });
    await expect(findBotToChange(prisma, scope, lead, "mail", "change")).resolves.toMatchObject({
      bot: { id: "mail" },
    });
  });

  it("lets a bot another bot created change only itself and its own bots", async () => {
    const prisma = prismaWithTeam();
    const cto = { id: "cto", parentBotId: "lead" };

    await expect(findBotToChange(prisma, scope, cto, "Architect", "change")).resolves.toMatchObject(
      { bot: { id: "cto" } },
    );
    await expect(findBotToChange(prisma, scope, cto, "Builder", "change")).resolves.toMatchObject({
      bot: { id: "dev" },
    });
    await expect(findBotToChange(prisma, scope, cto, "Courier", "change")).resolves.toEqual({
      error:
        "You can change yourself and the bots you created, not Courier. Ask the bot that leads the team.",
    });
    await expect(findBotToChange(prisma, scope, cto, "Chief", "read")).resolves.toMatchObject({
      bot: { id: "lead" },
      canChange: false,
    });
    await expect(findBotToChange(prisma, scope, cto, "Nobody", "read")).resolves.toEqual({
      error: 'No active bot called "Nobody".',
    });
  });
});

describe("nextInstructions", () => {
  const noFile = vi.fn();

  it("stores a long instructions file exactly as written", async () => {
    const text = `# Role\n${"Paragraph with umlauts äöü and **bold**.\n".repeat(400)}## End marker`;
    const readText = vi.fn().mockResolvedValue({ content: `\n${text}\n` });

    await expect(
      nextInstructions("Old.", { instructions_file: "drafts/cto.md" }, readText),
    ).resolves.toEqual({ instructions: text });
    expect(readText).toHaveBeenCalledWith("drafts/cto.md");
  });

  it("edits and appends without retyping the rest", async () => {
    const current = "Role: CTO.\n\nWork with: Chief.";

    await expect(
      nextInstructions(
        current,
        {
          instructions_edits: [{ old: "Work with: Chief.", new: "Work with: Chief, Courier." }],
          instructions_append: "Builder reports to you.",
        },
        noFile,
      ),
    ).resolves.toEqual({
      instructions: "Role: CTO.\n\nWork with: Chief, Courier.\n\nBuilder reports to you.",
    });
  });

  it("treats description as the same text, like the app does", async () => {
    await expect(nextInstructions("Old.", { description: "New." }, noFile)).resolves.toEqual({
      instructions: "New.",
    });
  });

  it("refuses unusable input", async () => {
    await expect(
      nextInstructions("A", { instructions_edits: [{ old: "missing", new: "x" }] }, noFile),
    ).resolves.toMatchObject({ error: expect.stringMatching(/appears 0 times/) });
    await expect(
      nextInstructions("A", { instructions: "B", instructions_file: "a.md" }, noFile),
    ).resolves.toEqual({ error: "Pass instructions or instructions_file, not both." });
    const readText = vi.fn().mockResolvedValue({ error: "file is not UTF-8 text" });
    await expect(nextInstructions("A", { instructions_file: "a.pdf" }, readText)).resolves.toEqual({
      error: "instructions_file a.pdf: file is not UTF-8 text",
    });
    await expect(
      nextInstructions("A", { instructions: "x".repeat(20_001) }, noFile),
    ).resolves.toEqual({ error: "Instructions would have 20001 characters; the limit is 20000." });
    await expect(nextInstructions("A", {}, noFile)).resolves.toEqual({});
  });
});

describe("nextDisabledTools", () => {
  it("turns built-in tools on and off", () => {
    expect(
      nextDisabledTools(["web_search"], {
        enable_tools: ["web_search"],
        disable_tools: "shell, browser_act",
      }),
    ).toEqual({ disabledBuiltinTools: ["shell", "browser_act"] });
    expect(nextDisabledTools([], {})).toEqual({});
  });

  it("refuses unknown tools and keeps the bot able to change itself", () => {
    expect(nextDisabledTools([], { disable_tools: ["teleport"] })).toEqual({
      error: "Unknown built-in tools: teleport.",
    });
    expect(nextDisabledTools([], { disable_tools: ["update_bot"] })).toEqual({
      error: "update_bot cannot be disabled by a bot.",
    });
  });
});

describe("nextMcpServers", () => {
  const prisma = {
    mcpServer: {
      findMany: vi.fn().mockResolvedValue([
        { id: "srv-1", name: "Laptop", slug: "laptop", enabled: true },
        { id: "srv-2", name: "Old", slug: "old", enabled: false },
      ]),
    },
  } as unknown as PrismaClient;

  it("finds servers by name or slug", async () => {
    await expect(
      nextMcpServers(prisma, scope, { add_mcp_servers: ["laptop"], remove_mcp_servers: ["Old"] }),
    ).resolves.toEqual({ add: ["srv-1"], remove: ["srv-2"] });
  });

  it("names the available servers when one is unknown", async () => {
    await expect(nextMcpServers(prisma, scope, { add_mcp_servers: ["Drive"] })).resolves.toEqual({
      error: "Unknown MCP servers: Drive. Available: Laptop, Old.",
    });
    await expect(nextMcpServers(prisma, scope, { add_mcp_servers: ["Old"] })).resolves.toEqual({
      error: "MCP servers turned off by the user: Old.",
    });
  });
});

describe("parseBotModel", () => {
  const prisma = {} as PrismaClient;

  it("checks the model against the connected providers", async () => {
    await expect(
      parseBotModel(prisma, scope, {
        model_provider: "anthropic",
        model_id: "claude-test",
        thinking_level: "high",
      }),
    ).resolves.toEqual({
      model: { modelProvider: "anthropic", modelId: "claude-test", thinkingLevel: "high" },
    });
    expect(validateConnectedModelChoice).toHaveBeenLastCalledWith(
      prisma,
      scope,
      "anthropic",
      "claude-test",
    );

    vi.mocked(validateConnectedModelChoice).mockResolvedValueOnce(
      "Connect that model provider first",
    );
    await expect(
      parseBotModel(prisma, scope, { model_provider: "openai", model_id: "gpt-x" }),
    ).resolves.toEqual({ error: "Connect that model provider first" });
  });

  it("refuses incomplete or unknown choices", async () => {
    await expect(parseBotModel(prisma, scope, { model_provider: "anthropic" })).resolves.toEqual({
      error: "Pass model_provider and model_id together.",
    });
    await expect(
      parseBotModel(prisma, scope, { thinking_level: "extreme" }),
    ).resolves.toMatchObject({
      error: expect.stringMatching(/^thinking_level must be one of off/),
    });
  });
});

describe("saveBotSetup", () => {
  it("keeps the app's description in step with the instructions", async () => {
    const tx = {
      bot: { update: vi.fn().mockResolvedValue({ id: "cto" }) },
      botMcpServer: { deleteMany: vi.fn(), upsert: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const instructions = "y".repeat(5_000);

    await saveBotSetup(prisma, scope, "cto", {
      profile: { title: "CTO" },
      instructions,
      model: { modelProvider: "anthropic", modelId: "claude-test" },
      disabledBuiltinTools: ["shell"],
      mcp: { add: ["srv-1"], remove: ["srv-2"] },
    });

    expect(tx.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cto" },
        data: {
          title: "CTO",
          modelProvider: "anthropic",
          modelId: "claude-test",
          instructions,
          description: instructions.slice(0, 4_000),
          disabledBuiltinTools: ["shell"],
        },
      }),
    );
    expect(tx.botMcpServer.deleteMany).toHaveBeenCalledWith({
      where: { botId: "cto", serverId: { in: ["srv-2"] } },
    });
    expect(tx.botMcpServer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId_serverId: { botId: "cto", serverId: "srv-1" } } }),
    );
  });
});
