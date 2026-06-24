import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// Hardcoded to the testing dir, so we don't mess outside of it for now
const sandboxPath = path.resolve("./sandbox/run");
await mkdir(sandboxPath, { recursive: true });
const SANDBOX_ROOT = await realpath(sandboxPath);

const ICON = "👮🏻‍♂️ ";
const ICON_ERROR = "🚨 ";
const API_KEY = process.env.ANTHROPIC_API_KEY_FOR_DREBIN;
const MODEL = "claude-opus-4-6";
const MAX_TOKENS = 1024;

type TextBlock = {
  type: "text";
  text: string;
};

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type UserMessage = {
  role: "user";
  content: string | (TextBlock | ToolResultBlock)[];
};

type AssistantMessage = {
  role: "assistant";
  content: (TextBlock | ToolUseBlock)[];
};

type Message = UserMessage | AssistantMessage;

type AssistantResponse = AssistantMessage & {
  id: string;
  stop_reason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | "refusal";
};

type ToolSchema = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

type Tool = {
  schema: ToolSchema;
  handler: (input: any) => Promise<string>;
};

export async function resolveInSandbox(inputPath: string): Promise<string> {
  var resolved = await realpath(inputPath);

  if (
    resolved !== SANDBOX_ROOT &&
    !resolved.startsWith(SANDBOX_ROOT + path.sep)
  ) {
    throw new Error(resolved + " resolves outside the sandbox");
  }
  return resolved;
}

async function readFile(input: { path: string }): Promise<string> {
  const safe = await resolveInSandbox(input.path);
  return Bun.file(safe).text();
}

export async function listDir(input: { path: string }): Promise<string[]> {
  const safe = await resolveInSandbox(input.path);
  return readdir(safe);
}

const toolRegistry: Record<string, Tool> = {
  read_file: {
    schema: {
      name: "read_file",
      description:
        "returns file contents as a string, fails on missing files, expects a path relative to cwd or an absolute path",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "absolute or relative path ",
          },
        },
        required: ["path"],
      },
    },
    handler: readFile,
  },
};

// we don't want to send the functions in handlers in our response
const tools = Object.values(toolRegistry).map((t) => t.schema);

async function request(messages: Message[]): Promise<AssistantMessage> {
  if (!API_KEY) {
    throw new Error("No ANTHROPIC_API_KEY_FOR_DREBIN found in the environment");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      tools,
    }),
  });

  if (!response.ok) {
    throw new Error(`API: ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as AssistantResponse;

  return {
    role: "assistant",
    content: data.content,
  };
}

async function readUserInput(): Promise<string | undefined> {
  for await (const line of console) return line;
}

async function dispatch(toolUse: ToolUseBlock): Promise<ToolResultBlock> {
  const tool = toolRegistry[toolUse.name];
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: `Unknown tool: ${toolUse.name}`,
      is_error: true,
    };
  }
  if (typeof (toolUse.input as any).path !== "string") {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: "input.path missing or not a string",
      is_error: true,
    };
  }

  try {
    const result: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: await tool.handler(toolUse.input),
      is_error: false,
    };

    return result;
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: err instanceof Error ? err.message : "Unknown Error",
      is_error: true,
    };
  }
}

async function main() {
  const messages: Message[] = [];
  while (true) {
    process.stdout.write(ICON);
    const input = await readUserInput();
    if (input === "/quit") {
      break;
    }
    if (!input || !input.trim()) {
      continue;
    }
    try {
      messages.push({ role: "user", content: input });
      while (true) {
        const response = await request(messages);
        messages.push(response);
        for (const block of response.content) {
          if (block.type === "text") {
            console.log(block.text);
          }
        }
        const toolUses = response.content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
          break;
        }
        const results = await Promise.all(toolUses.map(dispatch));
        messages.push({ role: "user", content: results });
        console.log(messages);
      }
    } catch (err) {
      messages.pop(); // we remove the last user message
      console.error(ICON_ERROR, err instanceof Error ? err.message : err);
      continue;
    }
  }
}

if (import.meta.main) {
  await main();
}
