# follet

A coding agent built from scratch — no framework, no SDK, raw `fetch` — to understand the mechanics behind production agents.

Years ago at a dev bootcamp I had to build my own jQuery before I was allowed to use the real one. It turned the magic into something I could reason about. `follet` is me doing the same thing with coding agents.

It's a learning project, not a product. Single user, runs in your terminal, talks to the Claude Messages API.

## The whole thing is four pieces

Strip an agent down and there isn't much to it:

1. **A loop** that keeps calling the model.
2. **Tools** — plain functions the model can ask you to run. It asks; your code does the running.
3. **The glue** that runs the requested tool and feeds the result back in.
4. **The conversation as a list you resend every turn**, because the model is stateless. It remembers nothing, so you replay the full history every call.

The loop barely changes between a toy like this and the real thing. What separates a basic agent from a sophisticated one is the quality of the tooling around the model: how tools are designed, how errors talk back, and where the safety boundary sits.

## Quickstart

Requires [Bun](https://bun.com).

```bash
bun install
```

Set your API key (follet reads a project-specific variable so it won't collide with other tools):

```bash
export ANTHROPIC_API_KEY_FOR_FOLLET=sk-ant-...
```

Run the interactive REPL:

```bash
bun main.ts
```

Type a request. The agent reasons, calls tools, and answers. Type `/quit` to exit.

## Two entry points, one core

The core is a factory, `createAgent()`, that returns the loop (`runStep`, `runToCheckpoint`) plus the approval-resume step. It's separate from how you talk to it, so the same core drives more than one interface:

- **`main.ts`** — an interactive terminal REPL.
- **`run-once.ts`** — a non-interactive view: runs a single prompt to completion and dumps the final state as JSON.

```bash
bun run-once.ts "what files are in ./sandbox/run?"
```

This split is the point of the design — a second interface needs zero changes to the core.

## Tools are injectable

`createAgent(tools)` closes the engine over a tool set. Call it with nothing and you get the built-in file tools; pass your own registry and follet runs those instead:

```ts
const agent = createAgent({ tools: { ...builtInToolRegistry, my_tool } });
await agent.runToCheckpoint(state);
```

The engine knows nothing about any specific tool — only the `ToolDefinition` shape: a schema, a handler, and an optional approval gate. That keeps follet a general engine. Vendor- or product-specific tools live in whatever project injects them, never in here.

### Writing a tool

A tool is a `ToolDefinition`:

```ts
import { toolError, type ToolDefinition } from "follet";

const my_tool: ToolDefinition = {
  schema: {
    name: "my_tool",
    description: "what the model sees",
    input_schema: { type: "object", properties: { /* … */ }, required: [] },
  },
  handler: async (input) => {
    if (bad(input)) {
      // recoverable: handed back to the model as data, not a crash
      throw toolError("bad_input", "what went wrong", "how to fix it");
    }
    return "result string the model reads";
  },
  needsApproval: true, // or a predicate on input; omit for auto-run tools
};
```

Two rules make a tool well-behaved:

- **Signal recoverable failure with `toolError(code, message, hint)`.** The engine feeds it back to the model as structured data. Any *other* throw is treated as a bug and crashes the process on purpose. The distinction is a private brand, so you must use the exported `toolError` — a look-alike object won't pass. This is the one intentional coupling: your tool depends on follet (the plugin depends on the host), never the reverse.
- **Gate side effects with `needsApproval`.** A `true` (or a predicate returning `true`) pauses the run at `awaiting_approval` so a human decides before the handler runs.

## Tools and the sandbox

follet ships four narrow file tools:

| Tool | Does |
|---|---|
| `read_file` | returns a file's contents |
| `list_dir` | lists a directory's entries |
| `grep` | returns lines in a file matching a regex, with line numbers |
| `write_file` | creates or overwrites a file — **pauses for your approval first** |

Every file path routes through one guard that resolves it (following symlinks) and rejects anything outside `./sandbox/run`. Put files you want the agent to see in that directory. The sandbox is gitignored.

## Tests

```bash
bun test
```

## Status

A toy, on purpose — single-user, sandboxed to `./sandbox/run`, and not hardened for anything beyond that. But the core mechanics are all here now: a resendable conversation, a tool loop, structured errors that talk back to the model, session persistence to disk, and a human-approval checkpoint before any mutating tool runs. Built phase by phase as a way to learn; expect rough edges.

## License

MIT. See [LICENSE](./LICENSE).
