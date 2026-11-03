#!/usr/bin/env node
// The commands. Rules live in core.ts; this file only wires them to the terminal, the Keychain and the server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import pkg from "../package.json" with { type: "json" };

import {
  addLines,
  answerIDs,
  BALANCED,
  chooseCurrent,
  emptyBatch,
  formatLine,
  isDue,
  lineFromRow,
  newLines,
  parseArgs,
  planAnswer,
  REALTIME,
  runnableName,
  takeBatch,
  typedLines,
  type Arguments,
  type Row,
} from "./core.ts";
import { commandHelp, guide, usage } from "./help.ts";
import { fixFor, formatSpeechLine, isHelperCache, megabytes, MODEL_PARTS, MODELS_BYTES, modelsFolder, modelsOnDisk, progressLine, speechSupport, statusText, steady, wantsModels, type SpeechEvent } from "./models.ts";
import { freeBytes, helper, logsFolder, platform, run as runSpeech, sharedWithScribe, spokenSample } from "./speech.ts";
import { describe, existingAnswer, followLines, followRecordings, followTyped, listRecordings, openLive, readLine, Refused, sendCode, verifyCode, write, type Live } from "./instant.ts";
import { deleteCredential, readCredential, writeCredential, type Credential } from "./keychain.ts";
import { APP_HINT, APP_LINK, TOOL } from "./names.ts";

/** The home folder as the system resolves it, as process.execPath is: a link in the way must not hide that it is home. */
function realHome(): string {
  try {
    return fs.realpathSync(process.env["HOME"] ?? "");
  } catch {
    return process.env["HOME"] ?? "";
  }
}

/** What this program is told to run itself as, everywhere it prints a command. */
const SELF = runnableName(TOOL, {
  path: process.env["PATH"] ?? "",
  execPath: process.execPath,
  home: realHome(),
  isExecutable: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
});

const say = (text: string): void => void process.stdout.write(`${text}\n`);
const complain = (text: string): void => void process.stderr.write(`${TOOL}: ${text}\n`);

async function signedIn(): Promise<Credential> {
  const credential = await readCredential();
  if (!credential) throw new Error(`not signed in on this Mac. Run: ${SELF} login`);
  return credential;
}

async function login(args: Arguments): Promise<void> {
  const prompts = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const email = (typeof args.flags["email"] === "string" ? args.flags["email"] : await prompts.question("The email you signed in with on your phone: ")).trim();
    if (!email.includes("@")) throw new Error("that is not an email address");
    // --code means the code is already in hand, so nothing is sent.
    const given = typeof args.flags["code"] === "string" ? args.flags["code"] : null;
    if (given === null) await sendCode(email);
    const code = (given ?? (await prompts.question(`The code sent to ${email}: `))).trim();
    const credential = await verifyCode(email, code);
    await writeCredential(credential);
    say(`Signed in as ${email}. The sign-in is in your Keychain; ${SELF} logout removes it.`);
  } finally {
    prompts.close();
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** Not needed to follow a recording: shown as "--" and never fails doctor. */
  optional?: boolean;
}

/** The speech models' row: read from the folders, so doctor fetches nothing (#1621). */
function speechCheck(): Check {
  const support = speechSupport(platform());
  if (!support.ok) return { name: "speech models", ok: false, optional: true, detail: support.why };
  const folder = modelsFolder(realHome());
  const found = modelsOnDisk(folder, (file) => fs.existsSync(file));
  if (found.complete) return { name: "speech models", ok: true, detail: `on this Mac${sharedWithScribe(folder) ? ", shared with Scribe for Mac" : ""}: ${SELF} transcribe FILE` };
  return {
    name: "speech models",
    ok: false,
    optional: true,
    detail: `not on this Mac yet (${megabytes(MODELS_BYTES)}, once); only ${SELF} transcribe needs them`,
    fix: `${SELF} models download`,
  };
}

/** Everything doctor checks: following a recording, then the speech models, which need no sign-in. */
async function doctorChecks(): Promise<Check[]> {
  return [...(await followChecks()), speechCheck()];
}

async function followChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const credential = await readCredential();
  checks.push(credential
    ? { name: "sign-in", ok: true, detail: `signed in${credential.email ? ` as ${credential.email}` : ""}` }
    : { name: "sign-in", ok: false, detail: "this Mac is not signed in", fix: `${SELF} login` });
  if (!credential) return checks;
  const started = Date.now();
  let rows: Row[];
  try {
    rows = await listRecordings(credential);
    checks.push({ name: "server", ok: true, detail: `answered in ${Date.now() - started} ms` });
  } catch (error) {
    checks.push({ name: "server", ok: false, detail: describe(error), fix: `check the network; if the sign-in expired, run ${SELF} login` });
    return checks;
  }
  checks.push(rows.length > 0
    ? { name: "recordings", ok: true, detail: `${rows.length}${rows.length === 8 ? " or more" : ""} readable, newest "${String(rows[0]?.["title"] ?? "untitled")}"` }
    : {
        name: "recordings",
        ok: false,
        detail: "this account has no recordings",
        fix: `get Vakyume on your iPhone if it is not there yet (${APP_LINK}). ${APP_HINT} Sign in under Settings > Account & Device with this same email, and record something. A phone that never signed in is a separate guest account.`,
      });
  const live = chooseCurrent(rows, Date.now());
  checks.push({ name: "live recording", ok: true, detail: live ? `"${String(live["title"] ?? "untitled")}" is live` : "none right now; watch waits for one" });
  return checks;
}

async function doctor(args: Arguments): Promise<number> {
  const checks = await doctorChecks();
  if (args.flags["json"]) {
    say(JSON.stringify({ version: pkg.version, checks }, null, 2));
  } else {
    for (const check of checks) {
      say(`${check.ok ? "ok  " : check.optional ? "--  " : "FAIL"} ${check.name}: ${check.detail}`);
      if (check.fix) say(`     ${check.optional ? "to get them" : "fix"}: ${check.fix}`);
    }
  }
  return checks.every((check) => check.ok || check.optional) ? 0 : 1;
}

async function list(args: Arguments): Promise<void> {
  const rows = await listRecordings(await signedIn());
  if (args.flags["json"]) return say(JSON.stringify(rows, null, 2));
  for (const row of rows) {
    const when = new Date(Number(row["startedAtMs"] ?? 0)).toLocaleString();
    say(`${String(row["id"])}  ${when}  ${row["activityKind"] === "active" ? "live  " : "      "}${String(row["title"] ?? "untitled")}`);
  }
  if (rows.length === 0) say("No recordings on this account.");
}

async function resolveRecording(credential: Credential, wanted: string): Promise<string> {
  if (wanted !== "current") return wanted.toLowerCase();
  const live = chooseCurrent(await listRecordings(credential), Date.now());
  if (!live) throw new Error(`no recording is live. Name one with --recording ID (see: ${SELF} list)`);
  return String(live["id"]);
}

/** The cursor to start from: --cursor, or the file the last run left, or the beginning. */
function startingCursor(args: Arguments): number {
  const file = typeof args.flags["cursor-file"] === "string" ? args.flags["cursor-file"] : null;
  const saved = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  const cursor = Number(args.flags["cursor"] ?? (saved || 0));
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error("--cursor is a line number");
  return cursor;
}

function saveCursor(file: string | null, cursor: number): void {
  if (file === null) return;
  // Written then renamed: a command that is killed never leaves half a number for the next run.
  fs.writeFileSync(`${file}.tmp`, `${cursor}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

async function watch(args: Arguments): Promise<void> {
  const credential = await signedIn();
  const wanted = typeof args.flags["recording"] === "string" ? args.flags["recording"].toLowerCase() : "current";
  const times = args.flags["mode"] === "realtime" ? REALTIME : BALANCED;
  const jsonl = args.flags["jsonl"] === true;
  const cursorFile = typeof args.flags["cursor-file"] === "string" ? args.flags["cursor-file"] : null;
  const startedAtMs = Date.now();
  const seen = new Set<string>();
  const typedSeen = new Set<string>();
  let next = startingCursor(args);
  let floor = next;
  let batch = emptyBatch();
  let following: string | null = null;
  let lines: Live | null = null;
  let typed: Live | null = null;
  let waitingSaid = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const db = await openLive(credential);

  const flush = (): void => {
    if (!isDue(batch, Date.now(), times)) return;
    const taken = takeBatch(batch);
    batch = emptyBatch();
    if (jsonl) for (const line of taken.lines) say(JSON.stringify({ recording: following, cursor: line.index + 1, ...line }));
    else {
      say(taken.header);
      for (const line of taken.lines) say(formatLine(line));
    }
    saveCursor(cursorFile, taken.cursor);
  };
  // A timer only while a batch waits, so a quiet recording costs no wakeups.
  const schedule = (): void => {
    if (timer !== null || batch.lines.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
      schedule();
    }, 250);
  };
  const follow = (recordingID: string, title: string): void => {
    lines?.close();
    typed?.close();
    following = recordingID;
    say(`following "${title}" (${recordingID}) from line ${next}`);
    lines = followLines(db, credential, recordingID, next, (rows) => {
      const fresh = newLines(rows, seen, next, floor);
      next = fresh.nextIndex;
      batch = addLines(batch, fresh.lines, Date.now());
      flush();
      schedule();
      return next;
    }, complain);
    typed = followTyped(db, recordingID, (rows) => {
      for (const text of typedLines(rows, typedSeen, startedAtMs)) say(text);
    }, complain);
  };

  const recordings = wanted === "current"
    ? followRecordings(db, (rows) => {
        const live = chooseCurrent(rows, Date.now());
        if (live && live["id"] !== following) {
          if (following !== null) next = floor = 0;
          seen.clear();
          follow(String(live["id"]), String(live["title"] ?? "untitled"));
        } else if (!live && following === null && !waitingSaid) {
          waitingSaid = true;
          say("waiting for a recording to go live");
        }
      }, complain)
    : null;
  if (recordings === null) follow(wanted, wanted);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      if (timer !== null) clearTimeout(timer);
      recordings?.close();
      lines?.close();
      typed?.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function reply(args: Arguments): Promise<void> {
  const credential = await signedIn();
  const index = Number(args.flags["segment"]);
  if (!Number.isInteger(index) || index < 0) throw new Error("--segment is a line number");
  const recordingID = await resolveRecording(credential, typeof args.flags["recording"] === "string" ? args.flags["recording"] : "current");
  const row = await readLine(credential, recordingID, index);
  const line = row ? lineFromRow(row) : null;
  if (!line) throw new Error(`line ${index} is not in this recording yet`);
  const agent = typeof args.flags["agent"] === "string" ? args.flags["agent"] : "agent";
  const text = args.words.join(" ");
  const ids = answerIDs(recordingID, line.id, text);
  const existing = await existingAnswer(credential, ids.threadID, ids.responseID);
  const plan = planAnswer({ recordingID, userID: credential.userID, line, text, agent, nowMs: Date.now(), threadExists: existing.thread, responseExists: existing.response });
  if (!plan.ok) throw new Error(plan.error);
  if (plan.value.steps.length > 0) await write(credential, plan.value.steps);
  say(`${plan.value.steps.length > 0 ? "answered" : "already answered"} at line ${index}: thread ${plan.value.threadID}`);
}

async function setup(args: Arguments): Promise<number> {
  if (!(await readCredential())) {
    say(`${TOOL} follows what Vakyume records on your iPhone. If Vakyume is not on your phone yet: ${APP_LINK}\n${APP_HINT}\n`);
    await login(args);
  }
  const code = await doctor(args);
  if (code === 0) await offerModels(args);
  say(code === 0 ? `\nYou are set. Now tell your coding agent to run: ${SELF} guide` : `\nFix the line above, then run: ${SELF} doctor`);
  return code;
}

/** The models step of setup (#1621): asked on a terminal, with Enter for yes; an agent passes --models. */
async function offerModels(args: Arguments): Promise<void> {
  if (args.flags["no-models"] || !speechSupport(platform()).ok) return;
  const folder = modelsFolder(realHome());
  if (modelsOnDisk(folder, (file) => fs.existsSync(file)).complete) return;
  let wanted = args.flags["models"] === true;
  if (!wanted && process.stdin.isTTY) {
    const prompts = createInterface({ input: process.stdin, output: process.stdout });
    try {
      wanted = wantsModels(
        await prompts.question(
          `\n${TOOL} can also write down audio files on this Mac with Scribe's own speech models: ${megabytes(MODELS_BYTES)}, downloaded once, and nothing you transcribe leaves this Mac. Download them now? [Y/n] `,
        ),
      );
    } finally {
      prompts.close();
    }
  }
  if (!wanted) {
    say(`\nTo transcribe on this Mac later: ${SELF} models download (${megabytes(MODELS_BYTES)}, once).`);
    return;
  }
  say("");
  // The models are optional: a download that stops says why and what to do, and the rest of setup still stands.
  try {
    if ((await downloadModels(args)) !== 0) say(`The speech models are not ready; the lines above say what to do. Everything else is set.`);
  } catch (error) {
    complain(describe(error));
    say(`The speech models are not ready. Everything else is set; run ${SELF} models download to try again.`);
  }
}

// ---- The speech models (#1621) ----

/** One line a terminal keeps rewriting. In a pipe, a line only when the key changes (a part, a tenth, five seconds), so
 *  an agent's log shows the download moving without a line per chunk. */
function progressShower(): { show(text: string, key: string): void; end(): void } {
  const tty = process.stderr.isTTY === true;
  let lastKey = "";
  let open = false;
  return {
    show(text, key) {
      if (tty) {
        process.stderr.write(`\r\x1b[2K${text}`);
        open = true;
      } else if (key !== lastKey) {
        process.stderr.write(`${text}\n`);
      }
      lastKey = key;
    },
    end() {
      if (open) process.stderr.write("\n");
      open = false;
    },
  };
}

function eventKey(event: Extract<SpeechEvent, { event: "progress" | "waiting" }>): string {
  return event.event === "waiting" ? `waiting:${event.compiling === true}:${Math.floor(event.seconds / 15)}` : `${event.part}:${event.compiling}:${Math.floor(event.fraction * 10)}`;
}

/** Says how long a wait has run, every second on a terminal and every 15 s in a pipe, until it is stopped: the models'
 *  first load compiles them for the Neural Engine, which can take two minutes, and a wait past 5 s says what it waits for. */
function waitingLine(what: string, shower: ReturnType<typeof progressShower>, options: { atOnce: boolean } = { atOnce: true }): () => void {
  const started = Date.now();
  const tick = (): void => {
    const seconds = Math.round((Date.now() - started) / 1000);
    shower.show(`${what}: ${seconds} s`, `wait:${Math.floor(seconds / 15)}`);
  };
  // A load that is over within a second says nothing.
  if (options.atOnce) tick();
  const timer = setInterval(tick, 1_000);
  return () => {
    clearInterval(timer);
    shower.end();
  };
}

async function speechHelper(shower: ReturnType<typeof progressShower>): Promise<string> {
  try {
    return await helper(realHome(), pkg.version, (done, total) => {
      const share = total ? `${Math.floor((done / total) * 100)}% of ${megabytes(total)}` : megabytes(done);
      shower.show(`Fetching spotter's speech helper: ${share}`, `fetch:${total ? Math.floor((done / total) * 10) : 0}`);
    });
  } finally {
    shower.end();
  }
}

function failed(ran: Awaited<ReturnType<typeof runSpeech>>, what: string): number {
  if (ran.error) {
    complain(ran.error.reason);
    process.stderr.write(`     fix: ${fixFor(ran.error, SELF)}\n`);
  } else {
    const said = ran.stderr.split("\n").slice(-3).join(" ").trim();
    complain(`the speech helper stopped (exit ${ran.code ?? "none"})${said ? `: ${said}` : ""}`);
    process.stderr.write(`     fix: ${fixFor({ event: "error", what, kind: "other", reason: "" }, SELF)}\n`);
  }
  return 1;
}

/** The helper's exact answer: what is on disk and what a download needs. */
async function speechStatus(speech: string, folder: string): Promise<Extract<SpeechEvent, { event: "status" }> | null> {
  let status: Extract<SpeechEvent, { event: "status" }> | null = null;
  await runSpeech(speech, ["status", "--models", folder], (event) => {
    if (event.event === "status") status = event;
  });
  return status;
}

async function downloadModels(args: Arguments): Promise<number> {
  const support = speechSupport(platform());
  if (!support.ok) return complain(support.why), 1;
  const home = realHome();
  const folder = modelsFolder(home);
  const logs = ["--logs", logsFolder(home)];
  const json = args.flags["json"] === true;
  const shower = progressShower();
  const speech = await speechHelper(shower);
  const status = await speechStatus(speech, folder);
  if (!status) return complain("the speech helper did not say what is on disk"), 1;
  if (!status.complete) {
    const free = freeBytes(folder);
    // Room for the files and the Neural Engine's compiled copies beside them.
    if (free !== null && free < status.bytesToDownload + 200_000_000) {
      complain(`this Mac's disk has ${megabytes(free)} free, and the models need ${megabytes(status.bytesToDownload)}`);
      process.stderr.write(`     fix: ${fixFor({ event: "error", what: "download", kind: "diskFull", reason: "" }, SELF)}\n`);
      return 1;
    }
    if (!json) say(`Downloading Scribe's speech models (${megabytes(status.bytesToDownload)}) from Hugging Face into ${folder}. A download that is cut continues where it stopped.`);
    const started = Date.now();
    let highest = 0;
    const ran = await runSpeech(speech, ["download", "--models", folder, ...logs], (event) => {
      if (json) return say(JSON.stringify(event));
      if (event.event === "progress") {
        const shown = steady(highest, event);
        highest = shown.fraction;
        shower.show(progressLine(shown), eventKey(shown));
      } else if (event.event === "waiting") {
        shower.show(progressLine(event), eventKey(event));
      }
    });
    shower.end();
    if (ran.code !== 0) return failed(ran, "download");
    if (!json) say(`Downloaded in ${Math.round((Date.now() - started) / 1000)} s.`);
  } else if (!json) {
    say(statusText(status, sharedWithScribe(folder), SELF));
  }
  // The first load compiles them for this Mac's Neural Engine, once; a transcript after that starts at once.
  const stop = waitingLine("Preparing them for the Neural Engine, once", shower);
  let prepared: Extract<SpeechEvent, { event: "prepared" }> | null = null;
  const ran = await runSpeech(speech, ["prepare", "--models", folder, ...logs], (event) => {
    if (event.event === "prepared") prepared = event;
    if (json) say(JSON.stringify(event));
  });
  stop();
  if (ran.code !== 0 || !prepared) return failed(ran, "prepare");
  if (!json) say(`Prepared in ${Math.round((prepared as Extract<SpeechEvent, { event: "prepared" }>).loadSeconds)} s.`);
  // A first transcript, of the Mac's own voice: the whole path, proved here rather than on the person's first file.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spotter-sample-"));
  try {
    const sample = spokenSample(scratch, "Spotter is ready to write down what you say.");
    if (sample) {
      const heard: string[] = [];
      const proof = await runSpeech(speech, ["transcribe", "--models", folder, ...logs, "--input", sample, "--no-speakers"], (event) => {
        if (event.event === "line") heard.push(event.text);
      });
      if (proof.code !== 0) return failed(proof, "transcribe");
      if (!json) say(`Tried on a spoken sample, it heard: "${heard.join(" ")}"`);
    } else if (!json) {
      say("No spoken test: the Mac's voice did not make a sample within 5 s. The models are ready all the same.");
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!json) say(`Ready. ${SELF} transcribe FILE writes down an audio file's words on this Mac.`);
  return 0;
}

function removeModels(): number {
  const home = realHome();
  const folder = modelsFolder(home);
  if (sharedWithScribe(folder)) {
    complain("Scribe for Mac uses these same files, so spotter leaves them. Remove them with Remove Models in Scribe's settings, or keep them: one copy serves both.");
    return 1;
  }
  for (const part of MODEL_PARTS) fs.rmSync(path.join(folder, part.folder), { recursive: true, force: true });
  fs.rmSync(path.join(home, "Library", "Application Support", TOOL), { recursive: true, force: true });
  // And the Neural Engine's compiled copies of them, about 40 MB for each helper that loaded them.
  const caches = path.join(home, "Library", "Caches");
  for (const name of fs.existsSync(caches) ? fs.readdirSync(caches) : []) {
    if (isHelperCache(name)) fs.rmSync(path.join(caches, name), { recursive: true, force: true });
  }
  say("Removed Scribe's speech models and spotter's speech helper from this Mac.");
  return 0;
}

/** The folders' size, for a status before the helper is fetched. */
function bytesUnder(folder: string): number {
  let total = 0;
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) total += fs.statSync(file).size;
    }
  };
  for (const part of MODEL_PARTS) if (fs.existsSync(path.join(folder, part.folder))) walk(path.join(folder, part.folder));
  return total;
}

async function models(args: Arguments): Promise<number> {
  const sub = args.words[0] ?? "status";
  if (sub === "download") return downloadModels(args);
  if (sub === "remove") return removeModels();
  if (sub !== "status") throw new Error(`unknown models command ${sub}. Run: ${SELF} models --help`);
  const support = speechSupport(platform());
  if (!support.ok) return say(support.why), 0;
  const folder = modelsFolder(realHome());
  // Nothing is fetched just to say what is on disk: the folders answer that.
  const found = modelsOnDisk(folder, (file) => fs.existsSync(file));
  const status = { complete: found.complete, bytesOnDisk: bytesUnder(folder), bytesToDownload: found.complete ? 0 : MODELS_BYTES, folder };
  if (args.flags["json"]) return say(JSON.stringify({ event: "status", ...status, missing: found.missing, sharedWithScribe: sharedWithScribe(folder) })), 0;
  say(statusText(status, sharedWithScribe(folder), SELF));
  return 0;
}

async function transcribe(args: Arguments): Promise<number> {
  const file = args.words[0];
  if (!file) throw new Error(`name the audio file: ${SELF} transcribe FILE`);
  const input = path.resolve(file);
  if (!fs.existsSync(input)) throw new Error(`${file}: there is no such file`);
  const support = speechSupport(platform());
  if (!support.ok) throw new Error(support.why);
  const home = realHome();
  const folder = modelsFolder(home);
  if (!modelsOnDisk(folder, (exists) => fs.existsSync(exists)).complete) {
    complain(statusText({ complete: false, bytesOnDisk: 0, bytesToDownload: MODELS_BYTES, folder }, false, SELF));
    return 1;
  }
  const shower = progressShower();
  const speech = await speechHelper(shower);
  const language = typeof args.flags["language"] === "string" ? args.flags["language"] : Intl.DateTimeFormat().resolvedOptions().locale;
  const json = args.flags["json"] === true;
  const argv = ["transcribe", "--models", folder, "--logs", logsFolder(home), "--input", input, "--language", language];
  if (args.flags["no-speakers"]) argv.push("--no-speakers");
  let stop: (() => void) | null = waitingLine("Loading Scribe's speech models", shower, { atOnce: false });
  const quiet = (): void => {
    stop?.();
    stop = null;
  };
  const ran = await runSpeech(speech, argv, (event) => {
    if (event.event === "loaded") quiet();
    if (event.event === "line") {
      quiet();
      say(json ? JSON.stringify({ start: event.start, end: event.end, speaker: event.speaker, text: event.text, words: event.words ?? [] }) : formatSpeechLine(event));
    }
    if (event.event === "summary" && !json && process.stderr.isTTY) {
      process.stderr.write(`${event.lines} lines from ${Math.round(event.audioSeconds)} s of audio in ${Math.round(event.wallSeconds)} s\n`);
    }
  });
  quiet();
  return ran.code === 0 ? 0 : failed(ran, "transcribe");
}

function help(args: Arguments): number {
  const topic = args.command === "help" ? (args.words[0] ?? "") : args.command;
  if (topic === "" || topic === "help") return say(usage(SELF, pkg.version)), 0;
  const page = commandHelp(SELF, topic);
  if (page === null) throw new Error(`unknown command ${topic}. Run: ${SELF} help`);
  return say(page), 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // Before anything a command does: --help never prompts, reads the Keychain or reaches the network.
  if (args.flags["help"] || args.command === "help") return help(args);
  if (args.flags["version"]) return say(`${TOOL} ${pkg.version}`), 0;
  switch (args.command) {
    case "": return help(args);
    case "setup": return setup(args);
    case "login": return login(args).then(() => 0);
    case "logout": return deleteCredential().then(() => (say("Signed out. This Mac holds no sign-in now."), 0));
    case "doctor": return doctor(args);
    case "list": return list(args).then(() => 0);
    case "watch": return watch(args).then(() => 0);
    case "reply": return reply(args).then(() => 0);
    case "models": return models(args);
    case "transcribe": return transcribe(args);
    case "guide": return say(guide(SELF)), 0;
    default: throw new Error(`unknown command ${args.command}. Run: ${SELF} help`);
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    complain(error instanceof Refused ? error.message : describe(error));
    process.exit(1);
  },
);
