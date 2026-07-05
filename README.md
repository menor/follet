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

The model loop (`runStep`) is separate from how you talk to it, so the same core drives more than one interface:

- **`main.ts`** — an interactive terminal REPL.
- **`run-once.ts`** — a non-interactive view: runs a single prompt to completion and dumps the final state as JSON.

```bash
bun run-once.ts "what files are in ./sandbox/run?"
```

This split is the point of the design — a second interface needs zero changes to the core.

## Tools and the sandbox

follet ships three narrow, read-only tools:

| Tool | Does |
|---|---|
| `read_file` | returns a file's contents |
| `list_dir` | lists a directory's entries |
| `grep` | returns lines in a file matching a regex, with line numbers |

Every file path routes through one guard that resolves it (following symlinks) and rejects anything outside `./sandbox/run`. Put files you want the agent to see in that directory. The sandbox is gitignored.

## Tests

```bash
bun test
```

## Status

A toy, on purpose. It is read-only, single-user, and not hardened for anything beyond a local sandbox. It's built phase by phase as a way to learn; expect rough edges and missing pieces (persistence, human checkpoints, and structured errors are on the way).

## License

MIT. See [LICENSE](./LICENSE).
