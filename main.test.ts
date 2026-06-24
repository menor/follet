import { test, expect, beforeAll, afterAll } from "bun:test";
import { listDir, resolveInSandbox } from "./main";
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
  expect(out).toContain("a.txt");
  expect(out).toContain("b.txt");
});

test("list_dir rejects a directory outside the sandbox", async () => {
  expect(listDir({ path: "/etc" })).rejects.toThrow();
});
