import { createWriteStream, WriteStream } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// ============================================================================
// CONFIG
// ============================================================================

const ICON = "🧚 ";
const ICON_ERROR = "🔥 ";
const API_KEY = process.env.ANTHROPIC_API_KEY_FOR_FOLLET;
const MODEL = "claude-opus-4-6"; // default; override per agent via createAgent({ model })
const MAX_TOKENS = 4096; // default; override per agent via createAgent({ maxTokens })

// Hardcoded to the testing dir, so we don't mess outside of it for now.
const SANDBOX_DIR = "./sandbox/run";
const SESSIONS_DIR = path.resolve("./.sessions");

// ============================================================================
// TYPES
// ============================================================================

export interface EventSink {
  append(messages: Message[]): Promise<void>;
  load(): Promise<Message[]>;
  close?(): Promise<void> | void;
}

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
  content: (TextBlock | ToolResultBlock)[];
};

type AssistantMessage = {
  role: "assistant";
  content: (TextBlock | ToolUseBlock)[];
};

export type Message = UserMessage | AssistantMessage;

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

export type ToolDefinition = {
  schema: ToolSchema;
  handler: (input: any) => Promise<string>;
  needsApproval?: boolean | ((input: any) => boolean);
};

export type ToolRegistry = Record<string, ToolDefinition>

export type Agent = ReturnType<typeof createAgent>;

type AgentStatus = "awaiting_approval" | "idle" | "thinking" | "done";

export type AgentState = {
  messages: Message[];
  status: AgentStatus;
};

// ============================================================================
// ERRORS
// ============================================================================

const TOOL_ERROR = Symbol("toolError");

// follet's own tools use these codes; an injected tool may pass any string.
// `string & {}` keeps ErrorCode autocompletion while still accepting anything.
type ErrorCode =
  | "outside_sandbox"
  | "not_found"
  | "bad_pattern"
  | "bad_input"
  | "command_failed";

// The error contract for tool handlers. Throw `toolError(...)` to signal a
// recoverable failure that should be handed back to the model as data; any
// other throw is treated as a bug and crashes the process. The brand is a
// private Symbol, so an injected tool MUST use this constructor — a plain
// object with the same fields won't pass `isToolError`.
export type ToolError = Error & { code: string; hint: string };

export function toolError(
  code: ErrorCode | (string & {}),
  message: string,
  hint: string,
): ToolError {
  return Object.assign(new Error(message), { [TOOL_ERROR]: true, code, hint });
}

function isToolError(e: unknown): e is ToolError {
  return e instanceof Error && TOOL_ERROR in e;
}

// ============================================================================
// SANDBOX
// ============================================================================

// Lazily resolved on first tool use so importing this module has no side effects.
const sandboxPath = path.resolve(SANDBOX_DIR);
let sandboxRoot: string | undefined;

export function assertInside(p: string, root: string): void {
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw toolError(
      "outside_sandbox",
      `${p} resolves outside the sandbox`,
      `Symlinks may not escape ${SANDBOX_DIR}.`,
    );
  }
}

export async function getSandboxRoot(): Promise<string> {
  if (!sandboxRoot) {
    await mkdir(sandboxPath, { recursive: true });
    sandboxRoot = await realpath(sandboxPath);
  }
  return sandboxRoot;
}

export async function resolveInSandbox(
  inputPath: string,
  { mustExist = true }: { mustExist?: boolean } = {},
): Promise<string> {
  if (typeof inputPath !== "string") {
    throw toolError(
      "bad_input",
      "path must be a string",
      `Pass a path as a string inside ${SANDBOX_DIR}.`,
    );
  }

  const root = await getSandboxRoot();

  // 1. Lexical boundary check FIRST — no disk, never throws on missing.
  //    This gives `outside_sandbox` its hint even when the path doesn't exist.
  const lexical = path.resolve(root, inputPath);
  assertInside(lexical, root);

  // 2. Canonicalize to defeat symlink escape — but convert "missing" to not_found.
  let resolved: string;
  try {
    resolved = await realpath(lexical);
    assertInside(resolved, root);
    return resolved;
  } catch (e) {
    // unexpected fs error → not anticipated → let it surface loudly
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;

    if (mustExist) {
      throw toolError(
        "not_found",
        `${inputPath} does not exist`,
        "Use list_dir to see what's in the sandbox.",
      );
    }

    let parent: string;
    try {
      parent = await realpath(path.dirname(lexical));
    } catch {
      throw toolError(
        "not_found",
        `the directory for ${inputPath} does not exist`,
        "Write only into a directory that already exists in the sandbox.",
      );
    }

    assertInside(parent, root);
    return path.join(parent, path.basename(lexical));
  }
}

// ============================================================================
// TOOLS
// ============================================================================

async function readFile(input: { path: string }): Promise<string> {
  const safe = await resolveInSandbox(input.path);
  return Bun.file(safe).text();
}

async function writeFile(input: {
  path: string;
  content: string;
}): Promise<string> {
  if (typeof input.content !== "string") {
    throw toolError(
      "bad_input",
      "write_file requires string content",
      "Pass the file body as a `content` string.",
    );
  }
  const safe = await resolveInSandbox(input.path, { mustExist: false });
  await Bun.write(safe, input.content);
  return `wrote ${input.content.length} bytes to ${input.path}`;
}

export async function listDir(input: { path: string }): Promise<string> {
  const safe = await resolveInSandbox(input.path);
  const entries = await readdir(safe, { withFileTypes: true });
  return entries
    .map((x) => (x.isDirectory() ? x.name + "/" : x.name))
    .join("\n");
}

export async function grep(input: {
  pattern: string;
  path: string;
}): Promise<string> {
  if (typeof input.pattern !== "string" || input.pattern === "") {
    throw toolError(
      "bad_input",
      "grep requires a non-empty pattern",
      "Pass a non-empty regex string as `pattern`.",
    );
  }
  const safe = await resolveInSandbox(input.path);
  const text = await Bun.file(safe).text();
  let re: RegExp;
  try {
    re = new RegExp(input.pattern);
  } catch {
    throw toolError(
      "bad_pattern",
      `Invalid regex: ${input.pattern}`,
      "Escape special characters or simplify the pattern.",
    );
  }

  const hits = text
    .replace(/\n$/, "")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter((row) => re.test(row.line))
    .map((row) => `${row.n}:${row.line}`);
  return hits.length ? hits.join("\n") : "(no matches)";
}

export const builtInToolRegistry: ToolRegistry = {
  grep: {
    schema: {
      name: "grep",
      description:
        "searches a single file for lines matching a regex; returns 'lineNumber:line' per match, or '(no matches)'",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "absolute or relative path of the file to search, must be inside the sandbox",
          },
          pattern: {
            type: "string",
            minLength: 1,
            description: "a JavaScript regular expression",
          },
        },
        required: ["path", "pattern"],
      },
    },
    handler: grep,
  },
  list_dir: {
    schema: {
      name: "list_dir",
      description:
        "lists the names of the files and dirs in a directory, directories end with a slash. expects a path inside the sandbox",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "absolute or relative directory path ",
          },
        },
        required: ["path"],
      },
    },
    handler: listDir,
  },
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
  write_file: {
    schema: {
      name: "write_file",
      description:
        "creates or overwrites a text file inside the sandbox with the given text content",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "absolute or relative path ",
          },
          content: {
            type: "string",
            description: "the full text to write",
          },
        },
        required: ["path", "content"],
      },
    },
    handler: writeFile,
    needsApproval: true,
  },
};

// ============================================================================
// CORE — model transport + state-in/state-out engine, transport-agnostic
// ============================================================================

export function createAgent({ tools = builtInToolRegistry, maxTokens = MAX_TOKENS, model = MODEL } = {}) {
  // we don't want to send the functions in handlers in our response
  const toolSchemas = Object.values(tools).map((t) => t.schema);

  async function request(messages: Message[]): Promise<AssistantMessage> {
    if (!API_KEY) {
      throw new Error("No ANTHROPIC_API_KEY_FOR_FOLLET found in the environment");
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages,
        tools: toolSchemas,
      }),
    });

    if (!response.ok) {
      throw new Error(`API: ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as AssistantResponse;

    // A truncated turn is an incomplete instruction — the last tool_use may be
    // half-formed. Refuse to act on it instead of guessing.
    if (data.stop_reason === "max_tokens") {
      throw toolError(
        "truncated",
        "Response cut off at max_tokens.",
        "Raise maxTokens or ask for less in one turn.",
      );
    }

    return {
      role: "assistant",
      content: data.content,
    };
  }

  async function dispatch(toolUse: ToolUseBlock): Promise<ToolResultBlock> {
    const tool = tools[toolUse.name];
    if (!tool) {
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: `Unknown tool: ${toolUse.name}`,
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
      if (isToolError(err)) {
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            code: err.code,
            message: err.message,
            hint: err.hint,
          }),
          is_error: true,
        };
      }
      throw err; // programmer error, DON'T feed it to the model, let it crash
    }
  }

  function toolNeedsApproval(use: ToolUseBlock): boolean {
    const gate = tools[use.name]?.needsApproval;
    return typeof gate === "function" ? gate(use.input) : gate === true;
  }

  async function runStep(state: AgentState): Promise<AgentState> {
    const response = await request(state.messages);
    const messages = [...state.messages, response];

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      return { messages, status: "done" };
    }

    if (toolUses.some(toolNeedsApproval)) {
      return { messages, status: "awaiting_approval" };
    }

    const results = await Promise.all(toolUses.map(dispatch));
    return {
      messages: [...messages, { role: "user", content: results }],
      status: "thinking",
    };
  }

  async function resumeAfterApproval(
    state: AgentState,
    approved: boolean,
  ): Promise<AgentState> {
    const last = state.messages.at(-1);
    if (!last) throw new Error("resumeAfterApproval called with no messages");

    const toolUses = last.content.filter((b) => b.type === "tool_use");

    const results: ToolResultBlock[] = approved
      ? await Promise.all(toolUses.map(dispatch))
      : toolUses.map((u) => ({
        type: "tool_result",
        tool_use_id: u.id,
        content: JSON.stringify({
          code: "denied",
          message: "A user declined this action",
          hint: "Do not retry it; explain or take a different approach.",
        }),
        is_error: true,
      }));

    return {
      messages: [...state.messages, { role: "user", content: results }],
      status: "thinking",
    };
  }

  async function runToCheckpoint(initial: AgentState): Promise<AgentState> {
    let state = initial
    while (state.status === "thinking") {
      state = await runStep(state)
    }
    return state
  }

  return { runStep, resumeAfterApproval, runToCheckpoint }
}

// ============================================================================
// PERSISTENCE
// ============================================================================

function sessionPath(id: string) {
  return path.join(SESSIONS_DIR, id + ".jsonl");
}

// A default interface in case no database is provided
export function jsonlSink(id: string): EventSink {
  const stream = createWriteStream(sessionPath(id), { flags: "a" });

  return {
    async append(messages: Message[]): Promise<void> {
      const lines = messages.map((m) => JSON.stringify(m) + "\n").join("");
      if (lines) stream.write(lines);
    },
    async load(): Promise<Message[]> {
      const text = await Bun.file(sessionPath(id)).text();
      return text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Message);
    },
    close() {
      stream.end();
    },
  };
}

// ============================================================================
// VIEW — the only I/O lives here
// ============================================================================

function render(messages: Message[], from: number) {
  for (const msg of messages.slice(from)) {
    for (const block of msg.content) {
      if (block.type === "text") console.log(block.text);
      if (block.type === "tool_use")
        console.log(`${ICON}→ ${block.name}(${JSON.stringify(block.input)})`);
      if (block.type === "tool_result")
        console.log(`   ${block.is_error ? ICON_ERROR : "✓"} ${block.content}`);
    }
  }
}


async function drive(
  agent: Agent,
  state: AgentState,
  shownFrom: number,
): Promise<AgentState> {
  let shown = shownFrom;
  while (state.status === "thinking") {
    state = await agent.runStep(state);
    render(state.messages, shown);
    shown = state.messages.length;
  }
  return state; // done or awaiting_approval
}

async function main() {
  const resumeFlag = process.argv.includes("--resume");

  const resumeId = resumeFlag
    ? process.argv[process.argv.indexOf("--resume") + 1]
    : undefined;

  if (resumeFlag && !resumeId) {
    throw new Error("--resume needs a session id to resume");
  }

  const sessionId = resumeId ?? crypto.randomUUID();
  console.log(`${ICON}session ${sessionId}`);

  const sink = jsonlSink(sessionId);
  const agent = createAgent()

  let state: AgentState = resumeId
    ? {
        messages: await sink.load(),
        status: "idle",
      }
    : {
        messages: [],
        status: "idle",
      };

  if (resumeId) {
    console.log(`resumed with ${state.messages.length} messages.`);
  }

  await mkdir(SESSIONS_DIR, { recursive: true });

  // Single line iterator for the whole session (idiomatic Bun stdin read).
  // Prompt before the loop, then once after each turn — no dangling icons.
  process.stdout.write(ICON);
  for await (const line of console) {
    const input = line.trim();
    let from: number;

    if (state.status === "awaiting_approval") {
      from = state.messages.length; // tool_use is already persisted
      state = await agent.resumeAfterApproval(state, input.toLowerCase() === "y");
    } else {
      if (input === "/quit") {
        break;
      }
      if (!input) {
        process.stdout.write(ICON);
        continue;
      }
      from = state.messages.length;
      state = {
        messages: [
          ...state.messages,
          { role: "user", content: [{ type: "text", text: input }] },
        ],
        status: "thinking",
      };
    }

    try {
      state = await drive(agent, state, from);
    } catch (err) {
      // drop failed turn;
      state = { messages: state.messages.slice(0, from), status: "idle" };
      console.error(ICON_ERROR, err instanceof Error ? err.message : err);
    }
    await sink.append(state.messages.slice(from));
    if (state.status === "awaiting_approval") {
      process.stdout.write("\n Approve? (y/n) ");
    } else {
      state = { ...state, status: "idle" };
      process.stdout.write(ICON);
    }
  }
  await sink.close?.();
}

if (import.meta.main) {
  await main();
}
