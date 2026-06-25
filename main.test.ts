import { test, expect, beforeAll, afterAll } from "bun:test";
import { grep, listDir, resolveInSandbox } from "./main";
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
  await expect(resolveInSandbox(leak)).rejects.toThrow();
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
  await expect(
    grep({ pattern: "root", path: "/etc/passwd" }),
  ).rejects.toThrow();
});

test("grep throws on an empty pattern (errors-as-data)", async () => {
  await expect(grep({ pattern: "", path: grepFile })).rejects.toThrow();
});
