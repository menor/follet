import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  grep,
  listDir,
  resolveInSandbox,
  runSol,
  solArgv,
  solEnv,
  solError,
  solNeedsApproval,
} from "./main";
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SANDBOX = path.resolve("./sandbox/run");
const realFile = path.join(SANDBOX, "ok.txt");
const leak = path.join(SANDBOX, "leak.txt");

beforeAll(async () => {
  await writeFile(realFile, "inside the sandbox");
  await symlink("/etc/passwd", leak); // a link pointing OUT of the sandbox
});

afterAll(async () => {
  await unlink(leak).catch(() => {});
  await unlink(realFile).catch(() => {});
});

test("allows a real file inside the sandbox", async () => {
  expect(await resolveInSandbox(realFile)).toBe(realFile);
});

test("rejects a symlink that escapes the sandbox", async () => {
  expect(resolveInSandbox(leak)).rejects.toThrow();
});

// listDir
const listDirPath = path.join(SANDBOX, "listme");

beforeAll(async () => {
  await mkdir(listDirPath, { recursive: true });
  await writeFile(path.join(listDirPath, "a.txt"), "one");
  await writeFile(path.join(listDirPath, "b.txt"), "two");
});
afterAll(async () => {
  await rm(listDirPath, { recursive: true, force: true });
});

test("list_dir lists the entries in a sandbox directory", async () => {
  const out = await listDir({ path: listDirPath });
  expect(out.split("\n").sort()).toEqual(["a.txt", "b.txt"]);
});

test("list_dir rejects a directory outside the sandbox", async () => {
  expect(listDir({ path: "/etc" })).rejects.toThrow();
});

// GREP tool
const grepFile = path.join(SANDBOX, "naked-gun.txt");

beforeAll(async () => {
  await writeFile(grepFile, "I'm Frank Drebin, Police Squad.\nDon't move!\n");
});
afterAll(async () => {
  await unlink(grepFile).catch(() => {});
});

test("grep returns matching lines with line numbers", async () => {
  const out = await grep({ pattern: "move", path: grepFile });
  expect(out).toBe("2:Don't move!");
});

test("grep rejects a file outside the sandbox", async () => {
  expect(grep({ pattern: "root", path: "/etc/passwd" })).rejects.toThrow();
});

test("grep throws on an empty pattern (errors-as-data)", async () => {
  expect(grep({ pattern: "", path: grepFile })).rejects.toThrow();
});

test("grep does not emit a phantom line for a trailing newline", async () => {
  const out = await grep({ pattern: "^", path: grepFile });
  expect(out.split("\n").length).toBe(2);
});

// write path — resolveInSandbox({ mustExist: false })
// A file we intend to CREATE doesn't exist yet, so the leaf can't be realpath'd;
// safety shifts to the parent dir. These lock that shift — and prove the leaf is
// still followed when it happens to exist (the symlinked-overwrite defense).
const newFile = path.join(SANDBOX, "willwrite.txt"); // never actually created
const escapeDir = path.join(SANDBOX, "escape-dir"); // symlink → outside the sandbox

beforeAll(async () => {
  await symlink("/tmp", escapeDir); // a directory link pointing OUT of the sandbox
});
afterAll(async () => {
  await unlink(escapeDir).catch(() => {});
});

test("write path resolves a not-yet-existing file whose parent is in the sandbox", async () => {
  expect(await resolveInSandbox(newFile, { mustExist: false })).toBe(newFile);
});

test("write path rejects a new file when the parent directory does not exist", async () => {
  const orphan = path.join(SANDBOX, "ghostdir", "f.txt");
  expect(resolveInSandbox(orphan, { mustExist: false })).rejects.toThrow();
});

test("write path rejects a new file inside a symlinked parent that escapes", async () => {
  const target = path.join(escapeDir, "x.txt"); // parent realpaths to /tmp
  expect(resolveInSandbox(target, { mustExist: false })).rejects.toThrow();
});

test("write path still rejects an existing symlinked leaf that escapes", async () => {
  // leaf EXISTS (it's the escaping symlink), so it is realpath'd and caught —
  // mustExist:false must NOT let a symlinked overwrite slip through.
  expect(resolveInSandbox(leak, { mustExist: false })).rejects.toThrow();
});

test("read path (default mustExist) rejects a missing file", async () => {
  const missing = path.join(SANDBOX, "nope.txt");
  expect(resolveInSandbox(missing)).rejects.toThrow();
});

test("solEnv does not leak drebin's own secrets into the child", () => {
  process.env.ANTHROPIC_API_KEY_FOR_DREBIN = "decoy-model-key";
  const env = solEnv("some-upsun-token");
  expect(env.ANTHROPIC_API_KEY_FOR_DREBIN).toBeUndefined();
  expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "UPSUN_TOKEN"]);
});

test("solEnv injects the token when set, omits the key when not", () => {
  expect(solEnv("t").UPSUN_TOKEN).toBe("t");
  expect("UPSUN_TOKEN" in solEnv("")).toBe(false); // "" is falsy → omitted; undefined would trigger the default
});

test("solArgv keeps the token out of the process arguments", () => {
  const argv = solArgv(["project:list"]);
  expect(argv).toEqual(["sol", "project:list", "-o", "json"]);
  expect(argv.join(" ")).not.toContain("token"); // the model's args are the ONLY variable part
});

test("solError forwards Sol's structured message and hint", () => {
  const body = JSON.stringify({
    error: {
      code: "unauthenticated",
      message: "not logged in",
      hint: "run auth:login",
    },
  });
  const e = solError(body, "", 1) as Error & { code: string; hint: string };
  expect(e.code).toBe("command_failed"); // drebin owns its code
  expect(e.message).toBe("not logged in"); // Sol's words, verbatim
  expect(e.hint).toBe("run auth:login"); // Sol's hint, not a guess
});

test("solError falls back when Sol emits no JSON", () => {
  const e = solError("", "boom", 1) as Error;
  expect(e.message).toBe("boom");
});

test("runSol rejects non-array args with bad_input", async () => {
  expect(runSol({ args: "project:list" as any })).rejects.toThrow();
});

test("read-only Sol verbs run without a human", () => {
  expect(solNeedsApproval({ args: ["project:list"] })).toBe(false);
  expect(solNeedsApproval({ args: ["environment:info", "main"] })).toBe(false);
  expect(solNeedsApproval({ args: ["version"] })).toBe(false);
});

test("mutating Sol verbs gate", () => {
  expect(solNeedsApproval({ args: ["environment:delete", "main"] })).toBe(true);
  expect(solNeedsApproval({ args: ["environment:redeploy"] })).toBe(true);
});

test("an unknown verb gates — deny by default", () => {
  expect(solNeedsApproval({ args: ["totally:new-verb"] })).toBe(true);
  expect(solNeedsApproval({ args: [] })).toBe(true); // no verb at all → gate
});
