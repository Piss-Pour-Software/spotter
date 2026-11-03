// Runs the real install.sh the way a person does, `curl ... | sh`, against a local server and a throwaway home folder.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const SCRIPT = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const VERSION = "9.9.9";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "spotter-install-"));
const files = new Map<string, Buffer>();
/** The places that take a download and then send nothing, as a dead connection does. */
const stalled = new Set<string>();
/** The places that send a download slowly, over about two seconds, as a slow link does (#1600). */
const slow = new Set<string>();
const asked: string[] = [];
let server: http.Server;
let port = 0;

function fakeTool(body: string): Buffer {
  const dir = fs.mkdtempSync(path.join(work, "tool-"));
  fs.writeFileSync(path.join(dir, "spotter"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const tarball = path.join(dir, "t.tar.xz");
  execFileSync("tar", ["-cJf", tarball, "-C", dir, "spotter"]);
  return fs.readFileSync(tarball);
}

const healthy = `case "$1" in --version) echo "spotter ${VERSION}";; setup) echo "setup ran";; logout) echo "signed out" >> "$HOME/logout-ran";; models) echo "$2" >> "$HOME/models-ran";; esac`;
const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

function stamp(arm64: Buffer, x64: Buffer, options: { sha?: string } = {}): string {
  return SCRIPT.replace(/^VERSION=.*$/m, `VERSION=${VERSION}`)
    .replace(/^SHA256_ARM64=.*$/m, `SHA256_ARM64=${options.sha ?? sha(arm64)}`)
    .replace(/^SHA256_X64=.*$/m, `SHA256_X64=${options.sha ?? sha(x64)}`)
    .replace(/^BASE_URL=.*$/m, `BASE_URL=http://127.0.0.1:${port}/release`)
    .replace(/^FALLBACK_URL=.*$/m, `FALLBACK_URL=http://127.0.0.1:${port}/github`);
}

function publish(arm64: Buffer, x64: Buffer, script = stamp(arm64, x64)): void {
  files.set("/install", Buffer.from(script));
  for (const place of ["release", "github"]) {
    files.set(`/${place}/spotter-${VERSION}-darwin-arm64.tar.xz`, arm64);
    files.set(`/${place}/spotter-${VERSION}-darwin-x64.tar.xz`, x64);
  }
}

interface Machine {
  home: string;
  shims: string;
}

/** A clean home, and optional stand-ins for what the machine reports about itself. */
function machine(reports: { unameS?: string; unameM?: string; arm64?: string } = {}): Machine {
  const home = fs.mkdtempSync(path.join(work, "home-"));
  const shims = fs.mkdtempSync(path.join(work, "shims-"));
  fs.writeFileSync(path.join(shims, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${reports.unameS ?? "Darwin"};; -m) echo ${reports.unameM ?? "arm64"};; esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(shims, "sysctl"), `#!/bin/sh\necho ${reports.arm64 ?? "1"}\n`, { mode: 0o755 });
  return { home, shims };
}

/** Asynchronous on purpose: the server answering curl runs in this same process. */
function capture(command: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const environment = (m: Machine): Record<string, string> => ({ HOME: m.home, PATH: `${m.shims}:/usr/bin:/bin:/usr/sbin`, SHELL: "/bin/zsh", TMPDIR: work });

function run(m: Machine, flags = "--no-setup") {
  return capture("/bin/sh", ["-c", `curl -fsSL http://127.0.0.1:${port}/install | sh -s -- ${flags}`], environment(m));
}

const installed = (m: Machine): string => path.join(m.home, ".local/bin/spotter");

before(async () => {
  server = http.createServer((request, response) => {
    const body = files.get(request.url ?? "");
    asked.push(request.url ?? "");
    if (!body) return void response.writeHead(404).end();
    if (slow.has((request.url ?? "").split("/")[1] ?? "")) {
      response.writeHead(200, { "content-length": String(body.length) });
      const step = Math.ceil(body.length / 8);
      let at = 0;
      const send = (): void => {
        response.write(body.subarray(at, at + step));
        at += step;
        if (at < body.length) setTimeout(send, 300);
        else response.end();
      };
      return send();
    }
    if (stalled.has((request.url ?? "").split("/")[1] ?? "")) {
      response.writeHead(200, { "content-length": String(body.length) });
      response.write(body.subarray(0, 100)); // and then nothing, as a dead connection does
      return;
    }
    response.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  publish(fakeTool(healthy), fakeTool(healthy));
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test("curl | sh installs the command for this user, and it runs", async () => {
  const m = machine();
  const result = await run(m);
  assert.equal(result.code, 0, result.out);
  assert.equal(execFileSync(installed(m), ["--version"], { encoding: "utf8" }).trim(), `spotter ${VERSION}`);
  assert.match(result.out, /Next: run/);
});

test("after installing, it says where to get the phone app the words come from", async () => {
  const result = await run(machine());
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /https:\/\/testflight\.apple\.com\/join\/nUxAwCM6/);
});

test("running it again changes nothing and says so", async () => {
  const m = machine();
  await run(m);
  const second = await run(m);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /already installed/);
});

test("a checksum that does not match installs nothing and says what it expected", async () => {
  const m = machine();
  const arm64 = fakeTool(healthy);
  publish(arm64, arm64, stamp(arm64, arm64, { sha: "0".repeat(64) }));
  const result = await run(m);
  publish(fakeTool(healthy), fakeTool(healthy));
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /checksum/);
  assert.match(result.out, new RegExp(`expected ${"0".repeat(64)}`));
  assert.equal(fs.existsSync(installed(m)), false);
});

test("a script cut off in the download runs nothing", async () => {
  const m = machine();
  const whole = files.get("/install")!;
  files.set("/install", whole.subarray(0, Math.floor(whole.length * 0.9)));
  const result = await run(m);
  files.set("/install", whole);
  assert.equal(fs.existsSync(path.join(m.home, ".local")), false, result.out);
});

test("a shell under Rosetta on Apple silicon still gets the arm64 build", async () => {
  const m = machine({ unameM: "x86_64", arm64: "1" });
  const result = await run(m);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /darwin-arm64/);
});

test("an Intel Mac gets the x64 build", async () => {
  const m = machine({ unameM: "x86_64", arm64: "0" });
  const result = await run(m);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /darwin-x64/);
});

test("anything but a Mac is refused with the reason", async () => {
  const result = await await run(machine({ unameS: "Linux" }));
  assert.equal(result.code, 1);
  assert.match(result.out, /macOS only/);
});

test("a binary that does not run is not installed", async () => {
  const m = machine();
  const broken = fakeTool("exit 3");
  publish(broken, broken);
  const result = await run(m);
  publish(fakeTool(healthy), fakeTool(healthy));
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /does not run/);
  assert.equal(fs.existsSync(installed(m)), false);
});

test("the file comes from the fast place, and GitHub is not asked", async () => {
  asked.length = 0;
  const result = await run(machine());
  assert.equal(result.code, 0, result.out);
  assert.ok(asked.includes(`/release/spotter-${VERSION}-darwin-arm64.tar.xz`));
  assert.deepEqual(asked.filter((url) => url.startsWith("/github/")), []);
});

test("with the fast place gone, the same file comes from GitHub", async () => {
  const m = machine();
  const name = `/release/spotter-${VERSION}-darwin-arm64.tar.xz`;
  const whole = files.get(name)!;
  files.delete(name);
  const result = await run(m);
  files.set(name, whole);
  assert.equal(result.code, 0, result.out);
  assert.equal(fs.existsSync(installed(m)), true);
});

test("a fast place that stalls costs five seconds, and GitHub finishes the install", async () => {
  const m = machine();
  stalled.add("release");
  const started = Date.now();
  const result = await run(m);
  stalled.clear();
  assert.equal(result.code, 0, result.out);
  assert.ok(Date.now() - started < 9_000, `took ${Date.now() - started} ms`);
  assert.equal(fs.existsSync(installed(m)), true);
});

test("a fast place that sends the wrong bytes is not believed", async () => {
  const m = machine();
  const name = `/release/spotter-${VERSION}-darwin-arm64.tar.xz`;
  const whole = files.get(name)!;
  files.set(name, fakeTool("exit 9"));
  const result = await run(m);
  files.set(name, whole);
  assert.equal(result.code, 0, result.out);
  assert.equal(execFileSync(installed(m), ["--version"], { encoding: "utf8" }).trim(), `spotter ${VERSION}`);
});

test("when neither place sends anything it stops within seconds and leaves nothing", async () => {
  const m = machine();
  stalled.add("release");
  stalled.add("github");
  const started = Date.now();
  const result = await run(m);
  stalled.clear();
  assert.equal(result.code, 1, result.out);
  // Two 5 s stalls, and room for a Mac under load: 16.5 s at a load of 180.
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
  assert.match(result.out, /could not download/);
  assert.equal(fs.existsSync(installed(m)), false);
});

test("the PATH line goes into .zshrc once, and uninstall takes only that line back", async () => {
  const m = machine();
  const rc = path.join(m.home, ".zshrc");
  fs.writeFileSync(rc, "alias keep=mine\n");
  await run(m);
  await run(m);
  const lines = fs.readFileSync(rc, "utf8").split("\n");
  assert.equal(lines.filter((line) => line.includes("added by the spotter installer")).length, 1);
  const removed = await run(m, "--uninstall");
  assert.equal(removed.code, 0, removed.out);
  assert.equal(fs.readFileSync(rc, "utf8"), "alias keep=mine\n");
});

test("uninstall keeps a .zshrc that is a link as a link", async () => {
  const m = machine();
  const real = path.join(m.home, "dotfiles-zshrc");
  fs.writeFileSync(real, "alias keep=mine\n");
  fs.symlinkSync(real, path.join(m.home, ".zshrc"));
  await run(m);
  await run(m, "--uninstall");
  assert.ok(fs.lstatSync(path.join(m.home, ".zshrc")).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), "alias keep=mine\n");
});

test("--no-modify-path leaves shell files alone and prints the line to add", async () => {
  const m = machine();
  const result = await run(m, "--no-setup --no-modify-path");
  assert.equal(fs.existsSync(path.join(m.home, ".zshrc")), false);
  assert.match(result.out, /export PATH=/);
});

test("--dry-run says what it would do and touches nothing", async () => {
  const m = machine();
  const result = await run(m, "--dry-run");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /would download/);
  assert.deepEqual(fs.readdirSync(m.home), []);
});

test("uninstall signs out first and removes the command", async () => {
  const m = machine();
  await run(m);
  const result = await run(m, "--uninstall");
  assert.equal(result.code, 0, result.out);
  assert.equal(fs.existsSync(installed(m)), false);
  assert.equal(fs.existsSync(path.join(m.home, "logout-ran")), true);
});

test("uninstall takes the speech models and their helper off too, through the command itself (#1621)", async () => {
  const m = machine();
  await run(m);
  const result = await run(m, "--uninstall");
  assert.equal(result.code, 0, result.out);
  assert.equal(fs.readFileSync(path.join(m.home, "models-ran"), "utf8"), "remove\n");
  assert.match(result.out, /speech models/);
});

// #1600: a 25 MB download at GitHub's 140 KB/s took 2.5 minutes with no sign of life, so a person watching sees curl's
// progress bar; an agent or a pipe gets none of it.
test("a person at a terminal sees the download move (#1600)", async () => {
  const m = machine();
  slow.add("release");
  try {
    const inner = `curl -fsSL http://127.0.0.1:${port}/install | sh -s -- --no-setup`;
    const result = await capture("/usr/bin/script", ["-q", "/dev/null", "/bin/sh", "-c", inner], environment(m));
    assert.match(result.out, /#+\s*\d+\.\d%/, result.out);
    assert.match(result.out, /Installed spotter/);
  } finally {
    slow.delete("release");
  }
});

test("an install through a pipe, as an agent runs it, prints no progress bar (#1600)", async () => {
  const result = await run(machine());
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /\d+\.\d%/);
});

test("with a terminal, the install goes straight into setup", async () => {
  const m = machine();
  const inner = `curl -fsSL http://127.0.0.1:${port}/install | sh`;
  const result = await capture("/usr/bin/script", ["-q", "/dev/null", "/bin/sh", "-c", inner], environment(m));
  assert.match(result.out, /setup ran/);
});

test("an address that is neither https nor this machine is refused", async () => {
  const m = machine();
  const plain = SCRIPT.replace(/^VERSION=.*$/m, `VERSION=${VERSION}`).replace(/^BASE_URL=.*$/m, "BASE_URL=http://example.com/release");
  const whole = files.get("/install")!;
  files.set("/install", Buffer.from(plain));
  const result = await run(m);
  files.set("/install", whole);
  assert.equal(result.code, 1);
  assert.match(result.out, /only over https/);
});

test("an installed copy is never run from the folder the installer was started in: an old program reads that folder", async () => {
  const m = machine();
  const folder = path.join(m.home, "a-cloned-repository");
  fs.mkdirSync(folder);
  const asked = path.join(m.home, "ran-in");
  const tells = fakeTool(`pwd >> "${asked}"\n${healthy}`);
  publish(tells, tells);
  const env = environment(m);
  const once = await capture("/bin/sh", ["-c", `cd "${folder}" && curl -fsSL http://127.0.0.1:${port}/install | sh -s -- --no-setup`], env);
  assert.equal(once.code, 0, once.out);
  await capture("/bin/sh", ["-c", `cd "${folder}" && curl -fsSL http://127.0.0.1:${port}/install | sh -s -- --uninstall`], env);
  publish(fakeTool(healthy), fakeTool(healthy));
  assert.ok(!fs.readFileSync(asked, "utf8").includes(folder), fs.readFileSync(asked, "utf8"));
});

test("the script needs no administrator and evaluates nothing", () => {
  const code = SCRIPT.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /\bsudo\b/);
  assert.doesNotMatch(code, /\beval\b/);
});
