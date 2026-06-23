import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolveInSandbox } from "./main";
import { symlink, unlink, writeFile } from "node:fs/promises";
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
