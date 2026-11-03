// The models and transcribe commands, run the way a person runs them (#1621), against a stand-in spotter-speech that
// prints what the real one prints and records how it was called. The real helper's own tests are the engine's.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "spotter-speech-"));
// A stand-in Keychain that holds nothing, as cli.test.ts's: no test reads this Mac's own.
fs.writeFileSync(path.join(work, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
after(() => fs.rmSync(work, { recursive: true, force: true }));

interface Home {
  home: string;
  models: string;
  calls: string;
}

/** A clean home, with the models' three folders when asked, and a stand-in helper that prints `lines` for a command. */
function home(options: { models?: boolean; shared?: boolean; lines?: Record<string, string[]>; exits?: Record<string, number> } = {}): Home & { helper: string } {
  const root = fs.mkdtempSync(path.join(work, "home-"));
  const models = path.join(root, "Library", "Application Support", "OnDeviceTranscription", "models");
  if (options.models) for (const part of ["parakeet-ultra", "vad/Models/silero-vad", "nemotron-3-diarization"]) fs.mkdirSync(path.join(models, part), { recursive: true });
  if (options.shared) fs.writeFileSync(path.join(models, "..", "compile-stamp.txt"), "stamp\n");
  const calls = path.join(root, "calls");
  const cases = Object.entries(options.lines ?? {})
    .map(([command, lines]) => `  ${command}) cat <<'EOF'\n${lines.join("\n")}\nEOF\n  exit ${options.exits?.[command] ?? 0} ;;`)
    .join("\n");
  const helper = path.join(root, "spotter-speech");
  fs.writeFileSync(helper, `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$1" in\n${cases}\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 });
  return { home: root, models, calls, helper };
}

function run(at: Home & { helper: string }, args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: `${work}:/usr/bin:/bin:/usr/sbin`, HOME: at.home, SPOTTER_SPEECH: at.helper, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const calls = (at: Home): string[] => (fs.existsSync(at.calls) ? fs.readFileSync(at.calls, "utf8").trim().split("\n") : []);

const LINES = [
  '{"event":"loaded","loadSeconds":1.5,"speakerLabels":true}',
  '{"event":"line","start":3.2,"end":4.1,"speaker":0,"text":"Hello there.","words":[{"text":"Hello","start":3.2,"end":3.6,"speaker":0},{"text":"there.","start":3.6,"end":4.1,"speaker":0}]}',
  '{"event":"line","start":5,"end":5.5,"speaker":1,"text":"Hi!","words":[{"text":"Hi!","start":5,"end":5.5,"speaker":1}]}',
  '{"event":"summary","audioSeconds":6,"wallSeconds":2,"loadSeconds":1.5,"lines":2,"speakerLabels":true}',
];

test("transcribe prints each line as watch does, and gives the helper the file, the models and the language", async () => {
  const at = home({ models: true, lines: { transcribe: LINES } });
  const audio = path.join(at.home, "meeting.m4a");
  fs.writeFileSync(audio, "audio");
  const result = await run(at, ["transcribe", audio, "--language", "en-GB"]);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "+0:03 [speaker 0] Hello there.\n+0:05 [speaker 1] Hi!\n");
  // spotter reads its home as the system resolves it (/var is /private/var), as it always has.
  const real = fs.realpathSync(at.home);
  assert.deepEqual(calls(at), [
    `transcribe --models ${real}/Library/Application Support/OnDeviceTranscription/models --logs ${real}/Library/Logs/spotter --input ${audio} --language en-GB`,
  ]);
});

test("transcribe --json is one object a line, with each word's times", async () => {
  const at = home({ models: true, lines: { transcribe: LINES } });
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  const result = await run(at, ["transcribe", audio, "--json", "--no-speakers"]);
  assert.equal(result.code, 0, result.err);
  const lines = result.out.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines[1], { start: 5, end: 5.5, speaker: 1, text: "Hi!", words: [{ text: "Hi!", start: 5, end: 5.5, speaker: 1 }] });
  assert.match(calls(at)[0] ?? "", / --no-speakers$/);
});

test("without the models, transcribe says what to run and starts nothing", async () => {
  const at = home({ lines: { transcribe: LINES } });
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  const result = await run(at, ["transcribe", audio]);
  assert.equal(result.code, 1);
  assert.match(result.err, /not on this Mac yet: 832 MB to download, once\. Run: spotter models download/);
  assert.deepEqual(calls(at), []);
});

test("a file that is not there is named, and nothing starts", async () => {
  const at = home({ models: true });
  const result = await run(at, ["transcribe", path.join(at.home, "missing.wav")]);
  assert.equal(result.code, 1);
  assert.match(result.err, /missing\.wav: there is no such file/);
  assert.deepEqual(calls(at), []);
});

test("when the helper stops, its reason and the one thing to do are shown", async () => {
  const at = home({
    lines: {
      status: ['{"event":"status","folder":"x","complete":false,"missing":[],"bytesToDownload":832000000,"bytesOnDisk":0}'],
      download: [
        '{"event":"progress","part":"words","title":"Parakeet Ultra, the words","fraction":0.1,"bytesDone":83200000,"bytesTotal":832000000,"compiling":false}',
        '{"event":"error","what":"download","kind":"offline","reason":"The Internet connection appears to be offline."}',
      ],
    },
    // The real helper exits 1 after its error line.
    exits: { download: 1 },
  });
  const result = await run(at, ["models", "download"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /The Internet connection appears to be offline\./);
  assert.match(result.err, /fix: Connect to the internet, then run: spotter models download\. It continues where it stopped\./);
  assert.match(result.err, /Downloading Parakeet Ultra, the words: 10%, 83 of 832 MB/);
});

test("models download downloads, prepares, tries a spoken sample, and says what to run next", async () => {
  const at = home({
    lines: {
      status: ['{"event":"status","folder":"x","complete":false,"missing":[],"bytesToDownload":832000000,"bytesOnDisk":0}'],
      download: ['{"event":"progress","part":"speakers","title":"Nemotron 3, who speaks","fraction":1,"bytesDone":832000000,"bytesTotal":832000000,"compiling":false}', '{"event":"downloaded","bytesOnDisk":794000000,"seconds":61.2}'],
      prepare: ['{"event":"prepared","loadSeconds":48.3,"speakerLabels":true}'],
      transcribe: ['{"event":"loaded","loadSeconds":0.4,"speakerLabels":false}', '{"event":"line","start":0.1,"end":2,"speaker":null,"text":"Spotter is ready to write down what you say."}'],
    },
  });
  // The sample is the test's own: `say` can take more than its 5 s on a loaded Mac.
  const sample = path.join(at.home, "sample.aiff");
  fs.writeFileSync(sample, "audio");
  const result = await run(at, ["models", "download"], { SPOTTER_SAMPLE: sample });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Downloading Scribe's speech models \(832 MB\) from Hugging Face into .*OnDeviceTranscription\/models\./);
  assert.match(result.out, /Prepared in 48 s\./);
  assert.match(result.out, /it heard: "Spotter is ready to write down what you say\."/);
  assert.match(result.out, /Ready\. spotter transcribe FILE writes down an audio file's words on this Mac\./);
  assert.deepEqual(calls(at).map((call) => call.split(" ")[0]), ["status", "download", "prepare", "transcribe"]);
});

test("models says where they are, and that Scribe for Mac shares them when it does", async () => {
  const mine = await run(home({ models: true }), ["models"]);
  assert.equal(mine.code, 0, mine.err);
  assert.match(mine.out, /^Scribe's speech models are on this Mac \(0 MB\), in .*OnDeviceTranscription\/models\.\n$/);
  const shared = await run(home({ models: true, shared: true }), ["models", "status"]);
  assert.match(shared.out, /shared with Scribe for Mac/);
  const none = await run(home(), ["models"]);
  assert.match(none.out, /not on this Mac yet: 832 MB to download, once\. Run: spotter models download/);
});

test("remove takes the models and the helper off, and leaves them when Scribe for Mac uses them", async () => {
  // Scribe for Mac's models stay; spotter's own helper and its compiled copies go.
  const shared = home({ models: true, shared: true });
  const sharedHelper = path.join(shared.home, "Library", "Application Support", "spotter");
  fs.mkdirSync(sharedHelper, { recursive: true });
  fs.writeFileSync(path.join(sharedHelper, "spotter-speech"), "helper");
  fs.mkdirSync(path.join(shared.home, "Library", "Caches", "spotter-speech"), { recursive: true });
  const cleared = await run(shared, ["models", "remove"]);
  assert.equal(cleared.code, 0, cleared.err);
  assert.match(cleared.out, /Scribe for Mac uses the models themselves, so they stay/);
  assert.ok(fs.existsSync(path.join(shared.models, "parakeet-ultra")));
  assert.equal(fs.existsSync(sharedHelper), false);
  assert.equal(fs.existsSync(path.join(shared.home, "Library", "Caches", "spotter-speech")), false);

  const mine = home({ models: true });
  fs.mkdirSync(path.join(mine.models, "parakeet-ctc-110m-coreml"), { recursive: true });
  const kept = path.join(mine.home, "Library", "Application Support", "spotter");
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, "spotter-speech-0.2.0"), "helper");
  const removed = await run(mine, ["models", "remove"]);
  assert.equal(removed.code, 0, removed.err);
  for (const part of ["parakeet-ultra", "vad", "nemotron-3-diarization"]) assert.equal(fs.existsSync(path.join(mine.models, part)), false, part);
  assert.ok(fs.existsSync(path.join(mine.models, "parakeet-ctc-110m-coreml")), "a model spotter did not download stays");
  assert.equal(fs.existsSync(kept), false);
});

test("doctor names the speech models as optional: their absence never fails it", async () => {
  const result = await run(home(), ["doctor", "--json"]);
  const checks = JSON.parse(result.out).checks as { name: string; ok: boolean; optional?: boolean }[];
  const speech = checks.find((check) => check.name === "speech models");
  assert.deepEqual({ ok: speech?.ok, optional: speech?.optional }, { ok: false, optional: true });
});

test("setup takes --models and --no-models, and transcribe --language and --no-speakers", async () => {
  for (const args of [["setup", "--no-models", "--help"], ["transcribe", "--no-speakers", "--language", "en-US", "--help"]]) {
    const result = await run(home(), args);
    assert.equal(result.code, 0, result.err);
  }
  const unknown = await run(home({ models: true }), ["transcribe", "a.wav", "--langauge", "en"]);
  assert.match(unknown.err, /unknown option --langauge/);
});

test("the download's line never goes back, though FluidAudio reports some files again after compiling others", async () => {
  // As the clean-home run printed it on the mini (2026-11-03 00:15): 30%, then preparing at 75%, then 37% again.
  const step = (fraction: number, compiling: boolean): string =>
    JSON.stringify({ event: "progress", part: "words", title: "Parakeet Ultra, the words", fraction, bytesDone: Math.round(fraction * 832e6), bytesTotal: 832e6, compiling });
  const at = home({
    lines: {
      status: ['{"event":"status","folder":"x","complete":false,"missing":[],"bytesToDownload":832000000,"bytesOnDisk":0}'],
      download: [step(0.3, false), step(0.75, true), step(0.37, false), step(0.8, false)],
      prepare: ['{"event":"prepared","loadSeconds":1,"speakerLabels":true}'],
    },
  });
  const result = await run(at, ["models", "download"]);
  assert.equal(result.code, 0, result.err);
  const percents = [...result.err.matchAll(/: (\d+)%/g)].map((match) => Number(match[1]));
  assert.deepEqual(percents, [30, 75, 75, 80]);
});

// ---- Fetching the helper from the release (#1621) ----

/** A release's helper archive, as publish.py makes it: the program and its licenses. */
function helperArchive(body: string): { bytes: Buffer; sha: string } {
  const dir = fs.mkdtempSync(path.join(work, "archive-"));
  fs.writeFileSync(path.join(dir, "spotter-speech"), body, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "licenses"));
  fs.writeFileSync(path.join(dir, "licenses", "FluidAudio-LICENSE"), "Apache License\n");
  const file = path.join(dir, "speech.tar.xz");
  execFileSync("/usr/bin/tar", ["-cJf", file, "-C", dir, "spotter-speech", "licenses"]);
  const bytes = fs.readFileSync(file);
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

const VERSION_LINE = '{"event":"version","protocol":1,"engine":"x"}';

async function serving(routes: Record<string, Buffer | "stall">, body: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer((request, response) => {
    const route = routes[request.url ?? ""];
    if (route === undefined) return void response.writeHead(404).end();
    if (route === "stall") return void response.writeHead(200, { "content-length": "1000" }).write("x");
    response.writeHead(200).end(route);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fetchEnv(at: Home, base: string, sha: string): Record<string, string> {
  return { SPOTTER_SPEECH_RELEASES: `${base}/fast,${base}/slow`, SPOTTER_SPEECH_SHA256: sha };
}

test("the first transcribe fetches the release's helper, checks it, keeps it with its licenses, and runs it", async () => {
  const at = home({ models: true });
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  const { bytes, sha } = helperArchive(`#!/bin/sh\ncase "$1" in version) echo '${VERSION_LINE}';; transcribe) echo '{"event":"line","start":1,"end":2,"speaker":null,"text":"Fetched."}';; esac\n`);
  await serving({ "/fast/v0.1.0/spotter-speech-0.1.0-darwin-arm64.tar.xz": bytes }, async (base) => {
    const result = await run(at, ["transcribe", audio], { ...fetchEnv(at, base, sha), SPOTTER_SPEECH: "" });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "+0:01 Fetched.\n");
  });
  const kept = path.join(fs.realpathSync(at.home), "Library", "Application Support", "spotter");
  assert.deepEqual(fs.readdirSync(kept).sort(), ["licenses", "spotter-speech", "spotter-speech.sha256"]);
  assert.equal(fs.readFileSync(path.join(kept, "spotter-speech.sha256"), "utf8").trim(), sha);
  assert.equal(fs.readFileSync(path.join(kept, "licenses", "FluidAudio-LICENSE"), "utf8"), "Apache License\n");
});

test("a helper whose bytes do not match the release's checksum is never kept or run", async () => {
  const at = home({ models: true });
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  const { bytes } = helperArchive(`#!/bin/sh\necho '${VERSION_LINE}'\n`);
  await serving({ "/fast/v0.1.0/spotter-speech-0.1.0-darwin-arm64.tar.xz": bytes, "/slow/v0.1.0/spotter-speech-0.1.0-darwin-arm64.tar.xz": bytes }, async (base) => {
    const result = await run(at, ["transcribe", audio], { ...fetchEnv(at, base, "0".repeat(64)), SPOTTER_SPEECH: "" });
    assert.equal(result.code, 1);
    assert.match(result.err, /checksum is wrong/);
  });
  assert.equal(fs.existsSync(path.join(fs.realpathSync(at.home), "Library", "Application Support", "spotter", "spotter-speech")), false);
});

test("a place that stalls costs 5 s, and the second place brings the helper", async () => {
  const at = home({ models: true });
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  const { bytes, sha } = helperArchive(`#!/bin/sh\ncase "$1" in version) echo '${VERSION_LINE}';; transcribe) echo '{"event":"line","start":0,"end":1,"speaker":0,"text":"Second place."}';; esac\n`);
  await serving({ "/fast/v0.1.0/spotter-speech-0.1.0-darwin-arm64.tar.xz": "stall", "/slow/v0.1.0/spotter-speech-0.1.0-darwin-arm64.tar.xz": bytes }, async (base) => {
    const started = Date.now();
    const result = await run(at, ["transcribe", audio], { ...fetchEnv(at, base, sha), SPOTTER_SPEECH: "" });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Second place\./);
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
  });
});

test("a release place that is neither https nor this Mac is refused", async () => {
  const at = home({ models: true });
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  const result = await run(at, ["transcribe", audio], { SPOTTER_SPEECH_RELEASES: "http://example.com/release", SPOTTER_SPEECH_SHA256: "0".repeat(64), SPOTTER_SPEECH: "" });
  assert.equal(result.code, 1);
  assert.match(result.err, /only over https/);
});

test("remove also takes the Neural Engine's compiled copies, which macOS keeps in Caches under the helper's name", async () => {
  const mine = home({ models: true });
  const caches = path.join(mine.home, "Library", "Caches");
  for (const name of ["spotter-speech-0.2.0", "spotter-speech-0.1.9", "spotter-speech", "com.example.other"]) {
    fs.mkdirSync(path.join(caches, name, "com.apple.e5rt.e5bundlecache"), { recursive: true });
  }
  const removed = await run(mine, ["models", "remove"]);
  assert.equal(removed.code, 0, removed.err);
  assert.deepEqual(fs.readdirSync(caches), ["com.example.other"]);
});

test("a newer helper replaces the old one under the same name, keeps its compiled copies, and drops 0.2.0's", async () => {
  const at = home({ models: true });
  const real = fs.realpathSync(at.home);
  const caches = path.join(real, "Library", "Caches");
  fs.mkdirSync(path.join(caches, "spotter-speech-0.2.0"), { recursive: true });
  fs.mkdirSync(path.join(caches, "spotter-speech"), { recursive: true });
  // The helper of an earlier release: its checksum is not this release's.
  const kept = path.join(real, "Library", "Application Support", "spotter");
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, "spotter-speech"), "#!/bin/sh\necho old\n", { mode: 0o755 });
  fs.writeFileSync(path.join(kept, "spotter-speech.sha256"), `${"1".repeat(64)}\n`);
  fs.writeFileSync(path.join(kept, "spotter-speech-0.2.0"), "old", { mode: 0o755 });
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  const { bytes, sha } = helperArchive(`#!/bin/sh\ncase "$1" in version) echo '${VERSION_LINE}';; transcribe) echo '{"event":"line","start":0,"end":1,"speaker":0,"text":"New."}';; esac\n`);
  await serving({ "/fast/v0.1.0/spotter-speech-0.1.0-darwin-arm64.tar.xz": bytes }, async (base) => {
    const result = await run(at, ["transcribe", audio], { ...fetchEnv(at, base, sha), SPOTTER_SPEECH: "" });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /New\./);
  });
  assert.deepEqual(fs.readdirSync(caches), ["spotter-speech"]);
  assert.deepEqual(fs.readdirSync(kept).sort(), ["licenses", "spotter-speech", "spotter-speech.sha256"]);
});

test("the helper already kept for this release is used as it is, with nothing fetched", async () => {
  const at = home({ models: true });
  const kept = path.join(fs.realpathSync(at.home), "Library", "Application Support", "spotter");
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, "spotter-speech"), `#!/bin/sh\ncase "$1" in transcribe) echo '{"event":"line","start":0,"end":1,"speaker":0,"text":"Kept."}';; esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(kept, "spotter-speech.sha256"), `${"2".repeat(64)}\n`);
  const audio = path.join(at.home, "a.wav");
  fs.writeFileSync(audio, "audio");
  // No release place answers: anything fetched would fail.
  const result = await run(at, ["transcribe", audio], { SPOTTER_SPEECH_RELEASES: "http://127.0.0.1:9/none", SPOTTER_SPEECH_SHA256: "2".repeat(64), SPOTTER_SPEECH: "" });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Kept\./);
});

test("when the Mac's voice cannot make the spoken sample, the download says the test was skipped and why", async () => {
  const at = home({
    lines: {
      status: ['{"event":"status","folder":"x","complete":true,"missing":[],"bytesToDownload":0,"bytesOnDisk":794000000}'],
      prepare: ['{"event":"prepared","loadSeconds":1,"speakerLabels":true}'],
    },
  });
  const result = await run(at, ["models", "download"], { SPOTTER_SAMPLE: path.join(at.home, "no-such-sample.aiff") });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /No spoken test: the Mac's voice did not make a sample within 5 s\. The models are ready all the same\./);
  assert.match(result.out, /Ready\./);
});
