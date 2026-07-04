import { createWriteStream, WriteStream } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// ============================================================================
// CONFIG
// ============================================================================

const ICON = "👮🏻‍♂️ ";
const ICON_ERROR = "🚨 ";
const UPSUN_TOKEN = process.env.UPSUN_TOKEN_FOR_DREBIN;
const API_KEY = process.env.ANTHROPIC_API_KEY_FOR_DREBIN;
const MODEL = "claude-opus-4-6";
const MAX_TOKENS = 1024;

// Hardcoded to the testing dir, so we don't mess outside of it for now.
const SANDBOX_DIR = "./sandbox/run";
const SESSIONS_DIR = path.resolve("./.sessions");

// Commands that don't need approval on sol (read commands)
const SOL_READ_SUFFIXES = [":list", ":get", ":info"];

// ============================================================================
// TYPES
// ============================================================================

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
  needsApproval?: boolean | ((input: any) => boolean);
};

type AgentStatus = "awaiting_approval" | "idle" | "thinking" | "done";

export type AgentState = {
  messages: Message[];
  status: AgentStatus;
};

// ============================================================================
// ERRORS
// ============================================================================

const TOOL_ERROR = Symbol("toolError");

type ErrorCode =
  | "outside_sandbox"
  | "not_found"
  | "bad_pattern"
  | "bad_input"
  | "command_failed";

function toolError(code: ErrorCode, message: string, hint: string) {
  return Object.assign(new Error(message), { [TOOL_ERROR]: true, code, hint });
}

function isToolError(
  e: unknown,
): e is Error & { code: ErrorCode; hint: string } {
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

async function getSandboxRoot(): Promise<string> {
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

// argv ARRAY, never a shell string: the model supplies only `args`;
// the binary and flags are fixed here. The token can't be an element — by shape.
export function solArgv(args: string[]): string[] {
  return ["sol", ...args, "-o", "json"];
}

// deny-by-default child env: allowlist ONLY what Sol needs, plus the secret.
// token defaults to the module value so prod calls solEnv() and tests pass their own.
export function solEnv(token = UPSUN_TOKEN): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "", // Sol must find its own dependencies
    HOME: process.env.HOME ?? "", // Sol reads its config/cache here
    ...(token ? { UPSUN_TOKEN: token } : {}), // the secret — injected, never in args
  };
}

export function solError(stdout: string, stderr: string, exitCode: number) {
  // Sol v0.2+ emits {error:{code,message,hint}} on STDOUT — the same contract
  // drebin speaks. Forward Sol's message and hint
  let message = stderr.trim() || `sol exited with code ${exitCode}`;
  let hint = "Add --schema to any command to inspect its arguments.";
  try {
    const { error } = JSON.parse(stdout);
    if (error?.message) message = error.message;
    if (error?.hint) hint = error.hint; // ← Sol's hint, not a guess
  } catch {
    /* no JSON (e.g. nothing on stdout) → keep the fallbacks above */
  }
  return toolError("command_failed", message, hint);
}

export function solNeedsApproval(input: { args: string[] }): boolean {
  const verb = input.args?.[0] || "";
  if (verb === "version") return false;
  return !SOL_READ_SUFFIXES.some((s) => verb.endsWith(s));
}

export async function runSol(input: { args: string[] }): Promise<string> {
  if (
    !Array.isArray(input.args) ||
    input.args.some((a) => typeof a !== "string")
  ) {
    throw toolError(
      "bad_input",
      "run_sol requires an array of string args",
      'Pass Sol\'s arguments as an `args` string array, e.g. ["version"].',
    );
  }

  const root = await getSandboxRoot();
  const proc = Bun.spawn(solArgv(input.args), {
    // ← argv ARRAY; -o json = parseable
    cwd: root, // ← run from inside the sandbox
    stdout: "pipe",
    stderr: "pipe",
    env: solEnv(),
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw solError(stdout, stderr, exitCode);
  }
  return stdout.trim() || "(sol produced no output)";
}

const toolRegistry: Record<string, Tool> = {
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
  run_sol: {
    schema: {
      name: "run_sol",
      description:
        "runs the Sol CLI (agent-optimized Upsun CLI) with the given arguments and returns its output. " +
        'Pass the subcommand and flags as array elements, e.g. ["version"] or ["project:list"]. ' +
        'Append "--schema" to any command to see its arguments WITHOUT running it.',
      input_schema: {
        type: "object",
        properties: {
          args: {
            type: "array",
            items: { type: "string" },
            description:
              'Sol subcommand and flags as separate strings, e.g. ["environment:list", "--schema"]',
          },
        },
        required: ["args"],
      },
    },
    handler: runSol,
    needsApproval: solNeedsApproval, // per command
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

// we don't want to send the functions in handlers in our response
const tools = Object.values(toolRegistry).map((t) => t.schema);

// ============================================================================
// MODEL
// ============================================================================

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

// ============================================================================
// CORE — state-in/state-out engine, transport-agnostic
// ============================================================================

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
  const gate = toolRegistry[use.name]?.needsApproval;
  return typeof gate === "function" ? gate(use.input) : gate === true;
}

export async function runStep(state: AgentState): Promise<AgentState> {
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

export async function resumeAfterApproval(
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

// ============================================================================
// PERSISTENCE
// ============================================================================

function sessionPath(id: string) {
  return path.join(SESSIONS_DIR, id + ".jsonl");
}

async function persist(sink: WriteStream, messages: Message[], from: number) {
  const lines = messages
    .slice(from)
    .map((m) => JSON.stringify(m) + "\n")
    .join("");
  if (lines) {
    sink.write(lines);
  }
}

async function loadSession(id: string): Promise<Message[]> {
  const text = await Bun.file(sessionPath(id)).text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Message);
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
  state: AgentState,
  shownFrom: number,
): Promise<AgentState> {
  let shown = shownFrom;
  while (state.status === "thinking") {
    state = await runStep(state);
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

  let state: AgentState = resumeId
    ? {
        messages: await loadSession(resumeId),
        status: "idle",
      }
    : {
        messages: [],
        status: "idle",
      };

  const sessionId = resumeId ?? crypto.randomUUID();
  console.log(`${ICON}session ${sessionId}`);

  if (resumeId) {
    console.log(`resumed with ${state.messages.length} messages.`);
  }

  await mkdir(SESSIONS_DIR, { recursive: true });
  // "a" flag appends, so resuming keeps the existing log intact
  const sink = createWriteStream(sessionPath(sessionId), { flags: "a" });
  // Single line iterator for the whole session (idiomatic Bun stdin read).
  // Prompt before the loop, then once after each turn — no dangling icons.
  process.stdout.write(ICON);
  for await (const line of console) {
    const input = line.trim();
    let from: number;

    if (state.status === "awaiting_approval") {
      from = state.messages.length; // tool_use is already persisted
      state = await resumeAfterApproval(state, input.toLowerCase() === "y");
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
      state = await drive(state, from);
    } catch (err) {
      // drop failed turn; the rolled-back slice means persist() below writes nothing
      state = { messages: state.messages.slice(0, from), status: "idle" };
      console.error(ICON_ERROR, err instanceof Error ? err.message : err);
    }
    await persist(sink, state.messages, from);
    if (state.status === "awaiting_approval") {
      process.stdout.write("\n Approve? (y/n) ");
    } else {
      state = { ...state, status: "idle" };
      process.stdout.write(ICON);
    }
  }
  sink.end();
}

if (import.meta.main) {
  await main();
}
