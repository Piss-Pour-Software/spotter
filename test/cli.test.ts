// Runs the real command the way a person does, on a machine where nothing is signed in: a stand-in `security` records any
// Keychain call, and standard input stays open, as a terminal's does, so a command that prompts would wait.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const COMMANDS = ["setup", "login", "logout", "doctor", "list", "watch", "reply", "models", "transcribe", "guide"];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "spotter-cli-"));
const calls = path.join(work, "security-calls");
fs.writeFileSync(path.join(work, "security"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 44\n`, { mode: 0o755 });

after(() => fs.rmSync(work, { recursive: true, force: true }));

/** The command's output and exit code. Killed after 4 s: help that waits for an answer never comes back by itself. */
function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: `${work}:/usr/bin:/bin`, HOME: work }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 4_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

for (const command of COMMANDS) {
  for (const flag of ["--help", "-h"]) {
    test(`spotter ${command} ${flag} prints ${command}'s help and does nothing else`, async () => {
      fs.rmSync(calls, { force: true });
      const result = await run([command, flag]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, new RegExp(`spotter ${command}\\b`), result.out);
      assert.equal(fs.existsSync(calls), false, "it touched the Keychain");
    });
  }
}

test("a command's help says what the command does and its options, not the whole list", async () => {
  const result = await run(["watch", "--help"]);
  assert.match(result.out, /--cursor-file/);
  assert.doesNotMatch(result.out, /spotter logout/);
});

test("spotter help login is the same page as spotter login --help", async () => {
  assert.equal((await run(["help", "login"])).out, (await run(["login", "--help"])).out);
});

test("spotter --help is the whole list, and so is spotter with nothing", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  for (const command of COMMANDS) assert.match(help.out, new RegExp(`spotter ${command}\\b`));
  assert.equal((await run([])).out, help.out);
});

test("help for a command that does not exist says so, and fails", async () => {
  const result = await run(["help", "nonsense"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /unknown command nonsense/);
});

test("logout --help signs nobody out", async () => {
  fs.rmSync(calls, { force: true });
  await run(["logout", "--help"]);
  assert.equal(fs.existsSync(calls), false);
});
