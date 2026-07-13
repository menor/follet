import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  grep,
  listDir,
  resolveInSandbox,
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
const grepFile = path.join(SANDBOX, "folklore.txt");

beforeAll(async () => {
  await writeFile(grepFile, "I'm a follet, a house sprite.\nDon't move!\n");
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
