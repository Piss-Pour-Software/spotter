#!/usr/bin/env node
// The commands. Rules live in core.ts; this file only wires them to the terminal, the Keychain and the server.

import fs from "node:fs";
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
}

async function doctorChecks(): Promise<Check[]> {
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
      say(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
      if (check.fix) say(`     fix: ${check.fix}`);
    }
  }
  return checks.every((check) => check.ok) ? 0 : 1;
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
  say(code === 0 ? `\nYou are set. Now tell your coding agent to run: ${SELF} guide` : `\nFix the line above, then run: ${SELF} doctor`);
  return code;
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
