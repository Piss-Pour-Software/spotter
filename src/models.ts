// The speech models' rules (#1621): which Macs can run them, where they live, what the helper says and what spotter
// prints for it. Pure, as core.ts is: src/speech.ts is the one file that downloads, runs the helper and reads the disk.
//
// The models are the ones Scribe's apps transcribe with on the device: Parakeet Ultra for the words, Silero for where
// speech is, Nemotron 3 for who speaks. spotter-speech, a small program built from the apps' own engine, downloads and
// runs them; spotter fetches it from the release the first time it is needed.

import { offset } from "./core.ts";
import { PUBLIC_REPO, SITE } from "./names.ts";

/** Parakeet Ultra 632 MB, Silero 1 MB, Nemotron 3 199 MB, as their Hugging Face repositories list them. */
export const MODELS_BYTES = 832_000_000;

export interface Platform {
  /** The hardware's answer (sysctl hw.optional.arm64), so a shell under Rosetta still counts as Apple silicon. */
  arm64: boolean;
  /** os.release()'s first number: 24 is macOS 15. */
  darwinMajor: number;
}

export type Support = { ok: true } | { ok: false; why: string };

const ELSEWHERE = "Everything else in spotter works here.";

/** The helper is built for Apple silicon and macOS 15 or later, where the apps' engine runs on the Neural Engine. */
export function speechSupport(platform: Platform): Support {
  if (!platform.arm64) return { ok: false, why: `Transcribing on this Mac needs Apple silicon (an M1 or later), and this Mac has an Intel processor. ${ELSEWHERE}` };
  if (platform.darwinMajor < 24) return { ok: false, why: `Transcribing on this Mac needs macOS 15 or later, and this Mac has macOS ${platform.darwinMajor - 9}. ${ELSEWHERE}` };
  return { ok: true };
}

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

/** Scribe for Mac's own folder for the same models: a Mac that has them downloads nothing. */
export function modelsFolder(home: string): string {
  return `${home}/Library/Application Support/OnDeviceTranscription/models`;
}

/** The three parts in the models folder: the folder each has (what removal takes), the path that is there once it is
 *  installed, and its name in a sentence. */
export const MODEL_PARTS: ReadonlyArray<{ folder: string; installed: string; title: string }> = [
  { folder: "parakeet-ultra", installed: "parakeet-ultra", title: "Parakeet Ultra, the words" },
  { folder: "vad", installed: "vad/Models/silero-vad", title: "Silero, where speech is" },
  { folder: "nemotron-3-diarization", installed: "nemotron-3-diarization", title: "Nemotron 3, who speaks" },
];

/** The three parts' folders, as the helper's own check finds them (DeviceModels in the engine), read without the helper:
 *  doctor answers from this and fetches nothing. The helper's `status` is the exact answer. */
export function modelsOnDisk(folder: string, exists: (file: string) => boolean): { complete: boolean; missing: string[] } {
  const missing = MODEL_PARTS.filter((part) => !exists(`${folder}/${part.installed}`)).map((part) => part.title);
  return { complete: missing.length === 0, missing };
}

/** Where spotter keeps the helper: one name across releases. macOS keeps the Neural Engine's compiled copies of the models
 *  under the program's name and identity: the same program finds them again (0.8 s), a changed one compiles them again
 *  (119.5 s; both measured on a Mac at load 400, #1621). A release that brings the same helper bytes, which the same build
 *  always gives, so costs no compile. `spotter-speech.sha256` beside it says which release's archive it came from. */
export function helperPath(home: string): string {
  return `${home}/Library/Application Support/spotter/spotter-speech`;
}

/** The Neural Engine's compiled copies of the models, which macOS keeps in ~/Library/Caches under the name of the program
 *  that loaded them (about 40 MB): `spotter-speech`, and `spotter-speech-0.2.0` from the one release that named it by version. */
export function isHelperCache(name: string): boolean {
  return name === "spotter-speech" || name.startsWith("spotter-speech-");
}

/** A compiled copy left by 0.2.0's helper, which named itself by version; nothing reads it now. */
export function isStaleHelperCache(name: string): boolean {
  return name.startsWith("spotter-speech-");
}

export function helperArchive(version: string): string {
  return `spotter-speech-${version}-darwin-arm64.tar.xz`;
}

/** Cloudflare first, GitHub second, as the installer does: either counts only if the checksum spotter carries matches. */
export function helperURLs(version: string): string[] {
  const archive = helperArchive(version);
  return [`https://${SITE}/download/v${version}/${archive}`, `https://github.com/${PUBLIC_REPO}/releases/download/v${version}/${archive}`];
}

export interface Word {
  text: string;
  start: number;
  end: number;
  speaker: number | null;
}

/** One line of spotter-speech's output: one JSON object a line, on standard output. */
export type SpeechEvent =
  | { event: "version"; protocol: number; engine: string }
  | { event: "status"; folder: string; complete: boolean; missing: { part: string; title: string; bytes: number }[]; bytesToDownload: number; bytesOnDisk: number }
  | { event: "progress"; part: string; title: string; fraction: number; bytesDone: number; bytesTotal: number; compiling: boolean }
  | { event: "waiting"; part: string; title: string; seconds: number; compiling?: boolean }
  | { event: "downloaded"; bytesOnDisk: number; seconds: number }
  | { event: "prepared"; loadSeconds: number; speakerLabels: boolean }
  | { event: "loaded"; loadSeconds: number; speakerLabels: boolean }
  | { event: "line"; start: number; end: number; speaker: number | null; text: string; words?: Word[] }
  | { event: "summary"; audioSeconds: number; wallSeconds: number; loadSeconds: number; lines: number; speakerLabels: boolean }
  | { event: "error"; what: string; kind: string; reason: string };

const EVENTS = new Set(["version", "status", "progress", "waiting", "downloaded", "prepared", "loaded", "line", "summary", "error"]);

/** A line the helper printed, or null: anything that is not one of its JSON objects is no event. */
export function parseEvent(line: string): SpeechEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const event = (value as Record<string, unknown>)["event"];
  return typeof event === "string" && EVENTS.has(event) ? (value as SpeechEvent) : null;
}

/** A progress line that never goes back: FluidAudio downloads and compiles a model's files in turn, and reports a file's
 *  download again after it compiled the one before, so its fraction can fall. The line shows the highest yet. */
export function steady(highest: number, event: Extract<SpeechEvent, { event: "progress" }>): Extract<SpeechEvent, { event: "progress" }> {
  const fraction = Math.max(highest, event.fraction);
  return { ...event, fraction, bytesDone: Math.round(fraction * event.bytesTotal) };
}

const percent = (fraction: number): number => Math.floor(Math.min(Math.max(fraction, 0), 1) * 100);

/** The one progress line a terminal keeps rewriting. */
export function progressLine(event: Extract<SpeechEvent, { event: "progress" | "waiting" }>): string {
  if (event.event === "waiting") {
    // A model is compiled once its bytes are in, with no progress of its own: that wait is preparing, not the network.
    return event.compiling
      ? `Preparing ${event.title}, for the Neural Engine: ${event.seconds} s`
      : `Downloading ${event.title}: no data for ${event.seconds} s, still trying`;
  }
  if (event.compiling) return `Preparing ${event.title}, for the Neural Engine: ${percent(event.fraction)}%`;
  return `Downloading ${event.title}: ${percent(event.fraction)}%, ${Math.round(event.bytesDone / 1e6)} of ${megabytes(event.bytesTotal)}`;
}

/** The one thing to do when the helper stops. */
export function fixFor(error: Extract<SpeechEvent, { event: "error" }>, self: string): string {
  const download = `${self} models download`;
  switch (error.kind) {
    case "offline":
      return `Connect to the internet, then run: ${download}. It continues where it stopped.`;
    case "diskFull":
      return `Free up ${megabytes(MODELS_BYTES)} on this Mac's disk, then run: ${download}. It continues where it stopped.`;
    case "missing":
      return `Run: ${download} (${megabytes(MODELS_BYTES)}, once), then try again.`;
    case "unreadable":
      return "Give it an audio file macOS can play (WAV, M4A, MP3, AIFF or CAF), or convert it first: afconvert -f WAVE -d LEI16 IN OUT.wav";
    default:
      return error.what === "download"
        ? `Run ${download} again: it continues where it stopped. If it stops the same way, the log in ~/Library/Logs/spotter says why.`
        : "Run the same command again. If it fails the same way, the log in ~/Library/Logs/spotter says why.";
  }
}

/** A transcribed line, as `watch` prints one: the time into the file, the speaker, the words. */
export function formatSpeechLine(line: { start: number; end: number; speaker: number | null; text: string }): string {
  const speaker = line.speaker === null ? "" : ` [speaker ${line.speaker}]`;
  return `${offset(line.start)}${speaker} ${line.text}`;
}

export function statusText(status: { complete: boolean; bytesOnDisk: number; bytesToDownload: number; folder: string }, shared: boolean, self: string): string {
  if (!status.complete) return `Scribe's speech models are not on this Mac yet: ${megabytes(status.bytesToDownload)} to download, once. Run: ${self} models download`;
  return `Scribe's speech models are on this Mac (${megabytes(status.bytesOnDisk)})${shared ? ", shared with Scribe for Mac" : ""}, in ${status.folder}.`;
}

/** Enter means yes: the question is asked with [Y/n]. */
export function wantsModels(answer: string): boolean {
  return ["", "y", "yes"].includes(answer.trim().toLowerCase());
}
