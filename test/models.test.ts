// The speech models' rules (#1621): which Macs can run them, where they live, what the helper says and what spotter
// prints for it, and the one thing to do when a download stops.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixFor,
  formatSpeechLine,
  helperArchive,
  helperPath,
  helperURLs,
  megabytes,
  modelsFolder,
  modelsOnDisk,
  MODELS_BYTES,
  parseEvent,
  progressLine,
  speechSupport,
  statusText,
  steady,
  wantsModels,
} from "../src/models.ts";

test("the models are the apps' three: 832 MB", () => {
  assert.equal(MODELS_BYTES, 832_000_000);
  assert.equal(megabytes(MODELS_BYTES), "832 MB");
  assert.equal(megabytes(357_760_000), "358 MB");
  assert.equal(megabytes(0), "0 MB");
});

test("an Apple silicon Mac on macOS 15 or later can transcribe; any other Mac is told why, in one line", () => {
  assert.deepEqual(speechSupport({ arm64: true, darwinMajor: 24 }), { ok: true });
  assert.deepEqual(speechSupport({ arm64: true, darwinMajor: 25 }), { ok: true });
  const old = speechSupport({ arm64: true, darwinMajor: 23 });
  assert.equal(old.ok, false);
  assert.match(old.ok ? "" : old.why, /macOS 15 or later/);
  const intel = speechSupport({ arm64: false, darwinMajor: 25 });
  assert.equal(intel.ok, false);
  assert.match(intel.ok ? "" : intel.why, /Apple silicon/);
  assert.match(intel.ok ? "" : intel.why, /everything else in spotter works here/i);
});

test("the models live where Scribe for Mac keeps them, so a Mac that has them downloads nothing", () => {
  assert.equal(modelsFolder("/home-of-someone"), "/home-of-someone/Library/Application Support/OnDeviceTranscription/models");
});

test("the helper is kept per version, and comes from the release: Cloudflare first, then GitHub", () => {
  assert.equal(helperPath("/home-of-someone", "0.2.0"), "/home-of-someone/Library/Application Support/spotter/spotter-speech-0.2.0");
  assert.equal(helperArchive("0.2.0"), "spotter-speech-0.2.0-darwin-arm64.tar.xz");
  assert.deepEqual(helperURLs("0.2.0"), [
    "https://spotter.pisspoursoftware.xyz/download/v0.2.0/spotter-speech-0.2.0-darwin-arm64.tar.xz",
    "https://github.com/Piss-Pour-Software/spotter/releases/download/v0.2.0/spotter-speech-0.2.0-darwin-arm64.tar.xz",
  ]);
});

test("the helper's lines are read one JSON object each; anything else is no event", () => {
  assert.deepEqual(parseEvent('{"event":"waiting","part":"words","title":"Parakeet Ultra, the words","seconds":7}'), {
    event: "waiting",
    part: "words",
    title: "Parakeet Ultra, the words",
    seconds: 7,
  });
  assert.equal(parseEvent("Loading models"), null);
  assert.equal(parseEvent('{"event":"surprise"}'), null);
  assert.equal(parseEvent("[1,2]"), null);
});

test("the progress line says what is downloading, how far, and in bytes", () => {
  const event = { event: "progress", part: "words", title: "Parakeet Ultra, the words", fraction: 0.43, bytesDone: 357_760_000, bytesTotal: 832_000_000, compiling: false } as const;
  assert.equal(progressLine(event), "Downloading Parakeet Ultra, the words: 43%, 358 of 832 MB");
  assert.equal(
    progressLine({ ...event, part: "speakers", title: "Nemotron 3, who speaks", fraction: 0.99, compiling: true }),
    "Preparing Nemotron 3, who speaks, for the Neural Engine: 99%",
  );
});

test("five seconds without data says so, and that it is still trying", () => {
  assert.equal(
    progressLine({ event: "waiting", part: "words", title: "Parakeet Ultra, the words", seconds: 7 }),
    "Downloading Parakeet Ultra, the words: no data for 7 s, still trying",
  );
});

test("a model being compiled after its download is preparing, not a stall: the line counts its seconds", () => {
  assert.equal(
    progressLine({ event: "waiting", part: "speakers", title: "Nemotron 3, who speaks", seconds: 12, compiling: true }),
    "Preparing Nemotron 3, who speaks, for the Neural Engine: 12 s",
  );
});

test("each way a download stops has one thing to do", () => {
  assert.match(fixFor({ event: "error", what: "download", kind: "offline", reason: "The Internet connection appears to be offline." }, "spotter"), /^Connect to the internet, then run: spotter models download\. It continues where it stopped\.$/);
  assert.match(fixFor({ event: "error", what: "download", kind: "diskFull", reason: "no space" }, "spotter"), /^Free up 832 MB on this Mac's disk, then run: spotter models download\./);
  const other = fixFor({ event: "error", what: "download", kind: "other", reason: "HTTP 503" }, "spotter");
  assert.match(other, /^Run spotter models download again: it continues where it stopped\./);
  assert.match(other, /Library\/Logs\/spotter/);
  assert.match(fixFor({ event: "error", what: "transcribe", kind: "missing", reason: "models missing: parakeet-ultra" }, "spotter"), /^Run: spotter models download/);
  assert.match(fixFor({ event: "error", what: "transcribe", kind: "unreadable", reason: "not audio" }, "spotter"), /audio file/);
});

test("a transcribed line reads like a watched one: the time into the file, the speaker, the words", () => {
  assert.equal(formatSpeechLine({ start: 3.21, end: 4, speaker: 0, text: "Hello there." }), "+0:03 [speaker 0] Hello there.");
  assert.equal(formatSpeechLine({ start: 3725, end: 3726, speaker: null, text: "Later." }), "+1:02:05 Later.");
});

test("the status says ready, shared or not, or what a download needs", () => {
  const folder = "/home-of-someone/Library/Application Support/OnDeviceTranscription/models";
  assert.equal(
    statusText({ complete: true, bytesOnDisk: 794_000_000, bytesToDownload: 0, folder }, true, "spotter"),
    `Scribe's speech models are on this Mac (794 MB), shared with Scribe for Mac, in ${folder}.`,
  );
  assert.equal(
    statusText({ complete: true, bytesOnDisk: 794_000_000, bytesToDownload: 0, folder }, false, "spotter"),
    `Scribe's speech models are on this Mac (794 MB), in ${folder}.`,
  );
  assert.equal(
    statusText({ complete: false, bytesOnDisk: 0, bytesToDownload: 832_000_000, folder }, false, "spotter"),
    "Scribe's speech models are not on this Mac yet: 832 MB to download, once. Run: spotter models download",
  );
});

test("the setup question takes Enter or yes as yes, and anything else as no", () => {
  for (const answer of ["", "y", "Y", "yes", " Yes "]) assert.equal(wantsModels(answer), true, JSON.stringify(answer));
  for (const answer of ["n", "no", "No", "later", "q"]) assert.equal(wantsModels(answer), false, JSON.stringify(answer));
});

test("before the helper is fetched, the three folders say whether the models are there", () => {
  const all = new Set(["/m/parakeet-ultra", "/m/vad/Models/silero-vad", "/m/nemotron-3-diarization"]);
  assert.deepEqual(modelsOnDisk("/m", (file) => all.has(file)), { complete: true, missing: [] });
  assert.deepEqual(modelsOnDisk("/m", (file) => file === "/m/parakeet-ultra"), {
    complete: false,
    missing: ["Silero, where speech is", "Nemotron 3, who speaks"],
  });
});

test("the shown fraction is the highest yet, and its bytes follow it", () => {
  const event = { event: "progress", part: "words", title: "Parakeet Ultra, the words", fraction: 0.37, bytesDone: 307_840_000, bytesTotal: 832_000_000, compiling: false } as const;
  assert.deepEqual(steady(0.75, event), { ...event, fraction: 0.75, bytesDone: 624_000_000 });
  assert.deepEqual(steady(0.2, event), { ...event, fraction: 0.37, bytesDone: 307_840_000 });
});
