// The one file that fetches spotter-speech, checks it, runs it and reads what it prints (#1621). The rules live in
// models.ts. The helper downloads and runs the models; spotter only reads its JSON lines.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { helperArchive, helperPath, helperURLs, isStaleHelperCache, parseEvent, type Platform, type SpeechEvent } from "./models.ts";
import { setting } from "./names.ts";
import { SPEECH_SHA256 } from "./release.ts";

/** The protocol of the helper's lines this spotter reads; a helper that prints another is refused. */
export const SPEECH_PROTOCOL = 1;

export function platform(): Platform {
  let arm64 = process.arch === "arm64";
  try {
    // The hardware's answer: a shell under Rosetta reports x86_64 on an Apple silicon Mac. An Intel Mac has no such key.
    arm64 = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "1";
  } catch {
    // Intel: process.arch stands.
  }
  return { arm64, darwinMajor: Number(os.release().split(".")[0]) };
}

/** Where the helper writes its log: ids, counts and timings, never words. */
export function logsFolder(home: string): string {
  return path.join(home, "Library", "Logs", "spotter");
}

/** Free bytes on the disk that holds `folder` (or its nearest existing parent), or null when the system will not say. */
export function freeBytes(folder: string): number | null {
  let at = folder;
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    const stats = fs.statfsSync(at);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Scribe for Mac has used this models folder: it writes the stamp of its own Core ML cache beside it. */
export function sharedWithScribe(models: string): boolean {
  return fs.existsSync(path.join(path.dirname(models), "compile-stamp.txt"));
}

export interface FetchProgress {
  (done: number, total: number | null): void;
}

/**
 * The helper this spotter was released with: SPOTTER_SPEECH when set (tests, a build from source), else the copy kept
 * under Application Support, else fetched from the release, checked against the checksum the release stamped in, and
 * kept. Each place is tried in turn; a download that brings no byte for 5 s is a stall, and the next place is tried.
 */
export async function helper(home: string, version: string, progress: FetchProgress): Promise<string> {
  const given = setting("SPEECH");
  if (given) return given;
  const target = helperPath(home);
  const stamp = `${target}.sha256`;
  // Tests serve a release of their own: SPOTTER_SPEECH_RELEASES (places, comma-separated) and SPOTTER_SPEECH_SHA256.
  const expected = setting("SPEECH_SHA256") ?? SPEECH_SHA256;
  if (expected !== "unset" && fs.existsSync(target) && readStamp(stamp) === expected) return target;
  const places = setting("SPEECH_RELEASES")?.split(",").map((base) => `${base}/v${version}/${helperArchive(version)}`) ?? helperURLs(version);
  if (expected === "unset") {
    throw new Error("this copy of spotter was not built as a release, so it has no speech helper to fetch: set SPOTTER_SPEECH to a spotter-speech built from the source");
  }
  const folder = path.dirname(target);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(folder, ".fetch-"));
  try {
    const archive = path.join(work, helperArchive(version));
    let problem = "";
    for (const url of places) {
      try {
        const sum = await download(url, archive, progress);
        if (sum === expected) {
          problem = "";
          break;
        }
        problem = `the download's checksum is wrong, so nothing was kept: expected ${expected}, got ${sum}`;
      } catch (error) {
        problem = `could not download ${url}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (problem) throw new Error(`${problem}. Check the network and run this again.`);
    // A 10 MB xz archive unpacks in well under a second; 5 s is the rule.
    execFileSync("/usr/bin/tar", ["-xf", archive, "-C", work], { timeout: 5_000, stdio: "ignore" });
    const unpacked = path.join(work, "spotter-speech");
    if (!fs.existsSync(unpacked)) throw new Error("the speech helper's archive holds no spotter-speech");
    fs.chmodSync(unpacked, 0o755);
    const said = versionOf(unpacked);
    if (said?.protocol !== SPEECH_PROTOCOL) throw new Error("the downloaded speech helper does not run on this Mac, so nothing was kept");
    // Renamed into place, so a half-written helper is never run; the stamp follows, so a cut between them fetches again.
    fs.renameSync(unpacked, target);
    fs.writeFileSync(stamp, `${expected}\n`);
    // Its licenses (FluidAudio's Apache License and those it carries) stay beside it.
    const licenses = path.join(work, "licenses");
    if (fs.existsSync(licenses)) {
      fs.rmSync(path.join(folder, "licenses"), { recursive: true, force: true });
      fs.renameSync(licenses, path.join(folder, "licenses"));
    }
    // 0.2.0 kept its helper, and macOS its compiled copies, under a versioned name: nothing reads those now.
    for (const name of fs.readdirSync(folder)) {
      if (name.startsWith("spotter-speech-")) fs.rmSync(path.join(folder, name), { force: true });
    }
    const caches = path.join(home, "Library", "Caches");
    for (const name of fs.existsSync(caches) ? fs.readdirSync(caches) : []) {
      if (isStaleHelperCache(name)) fs.rmSync(path.join(caches, name), { recursive: true, force: true });
    }
    return target;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The checksum of the archive the kept helper came from, or "" when there is none. */
function readStamp(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** One file to `file`, hashed as it arrives: its SHA-256. Fails when no byte comes for 5 s. */
async function download(url: string, file: string, progress: FetchProgress): Promise<string> {
  // As the installer: https, or this Mac for a test.
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1")) throw new Error(`downloads go only over https, not ${url}`);
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 5_000);
  const quiet = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 5_000);
  };
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length")) || null;
    const hash = createHash("sha256");
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let done = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        quiet();
        hash.update(chunk);
        done += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
        progress(done, total);
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
    return hash.digest("hex");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("no data for 5 s");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** What the helper says it is, or null when it does not run here. */
export function versionOf(file: string): { protocol: number; engine: string } | null {
  try {
    const out = execFileSync(file, ["version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    const event = parseEvent(out.trim().split("\n")[0] ?? "");
    return event?.event === "version" ? { protocol: event.protocol, engine: event.engine } : null;
  } catch {
    return null;
  }
}

export interface Ran {
  code: number | null;
  error: Extract<SpeechEvent, { event: "error" }> | null;
  /** The end of what the helper wrote to standard error: a crash's own words. */
  stderr: string;
}

/** Runs the helper, handing each of its lines over as it comes. */
export function run(file: string, args: string[], onEvent: (event: SpeechEvent) => void): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let error: Extract<SpeechEvent, { event: "error" }> | null = null;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4_000)));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseEvent(line);
      if (!event) return;
      if (event.event === "error") error = event;
      onEvent(event);
    });
    child.on("error", (failure) => resolve({ code: null, error, stderr: failure.message }));
    child.on("close", (code) => resolve({ code, error, stderr: stderr.trim() }));
  });
}

/** A short spoken sample for the first proof, in the Mac's own voice: `say` is on every Mac and needs no network. Tests
 *  give their own (SPOTTER_SAMPLE). */
export function spokenSample(folder: string, words: string): string | null {
  const given = setting("SAMPLE");
  if (given) return fs.existsSync(given) ? given : null;
  const file = path.join(folder, "spotter-sample.aiff");
  try {
    // A sentence takes `say` about a second; past 5 s the proof is skipped, never the models.
    execFileSync("/usr/bin/say", ["-o", file, words], { timeout: 5_000, stdio: "ignore" });
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}
