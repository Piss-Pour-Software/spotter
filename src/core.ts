// The tool's pure core: no network, no Keychain, no clock of its own, so every rule here is tested without a server.
// src/instant.ts is the one file that talks to Instant, src/keychain.ts the one that touches the Keychain.

import { createHash } from "node:crypto";

import { ID_NAMESPACE, TOOL } from "./names.ts";

export type Row = Record<string, unknown>;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Line {
  id: string;
  index: number;
  startSeconds: number;
  wallClockMs: number | null;
  speaker: number | null;
  text: string;
  sealed: boolean;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A line to hand over, or null: a line still being said is not final, and a retired line was replaced by another. */
export function lineFromRow(row: Row): Line | null {
  const id = str(row["id"]);
  const index = num(row["segmentIndex"]);
  if (id === null || index === null || row["isFinal"] !== true || num(row["retiredAtMs"]) !== null) return null;
  const sealed = str(row["wordsSeal"]) !== null;
  return {
    id,
    index,
    startSeconds: num(row["startTimeSeconds"]) ?? 0,
    wallClockMs: num(row["wallClockStartedAtMs"]),
    speaker: num(row["speaker"]),
    // A sealed line's text is empty by design; its envelope is never read here.
    text: sealed ? "" : (str(row["text"]) ?? ""),
    sealed,
  };
}

function clock(ms: number | null): string {
  return ms === null ? "--:--:--" : new Date(ms).toTimeString().slice(0, 8);
}

export function offset(seconds: number): string {
  const whole = Math.floor(seconds);
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `+${h}:${pad(m)}:${pad(s)}` : `+${m}:${pad(s)}`;
}

export function formatLine(line: Line): string {
  const speaker = line.speaker === null ? "" : ` [speaker ${line.speaker}]`;
  const words = line.sealed ? " [sealed]" : ` ${line.text}`;
  return `${clock(line.wallClockMs)} ${offset(line.startSeconds)} #${line.index}${speaker}${words}`;
}

// ---- The moving window ----
//
// A live query restates its whole result every time a row in it changes, so a query for every line of a recording costs
// more with each line said. The window is a page from just before the next line, reopened once half used, so a refresh
// costs about the same at line 30 and at line 30,000: 2 to 16 KB over the WebSocket (src/instant.ts says why that one).

export const WINDOW_LINES = 32;
/** Lines read again behind the cursor, so a line that lands just after a later one is still handed over. */
export const WINDOW_BACKSTEP = 8;
const SEEN_LIMIT = 256;
const LINE_FIELDS = ["segmentIndex", "startTimeSeconds", "wallClockStartedAtMs", "speaker", "text", "isFinal", "retiredAtMs", "wordsSeal"];

export function windowStart(nextIndex: number): number {
  return Math.max(0, nextIndex - WINDOW_BACKSTEP);
}

export function windowQuery(recordingID: string, nextIndex: number): object {
  return {
    transcriptionSegments: {
      $: {
        where: { recordingID, segmentIndex: { $gte: windowStart(nextIndex) } },
        order: { segmentIndex: "asc" },
        limit: WINDOW_LINES,
        fields: LINE_FIELDS,
      },
    },
  };
}

export function shouldReopen(openedAtIndex: number, nextIndex: number): boolean {
  return nextIndex - openedAtIndex >= WINDOW_LINES / 2;
}

/** The lines of a result not handed over yet, in order. Nothing below `floor`, the cursor this run started from, goes
 *  out: the window reads a little behind the cursor, and a new run has no memory of what the last one printed. `seen` is
 *  kept bounded: the oldest ids leave first. */
export function newLines(rows: readonly Row[], seen: Set<string>, nextIndex: number, floor: number): { lines: Line[]; nextIndex: number } {
  const lines: Line[] = [];
  let next = nextIndex;
  for (const row of [...rows].sort((a, b) => (num(a["segmentIndex"]) ?? 0) - (num(b["segmentIndex"]) ?? 0))) {
    const index = num(row["segmentIndex"]);
    const id = str(row["id"]);
    if (index === null || id === null || row["isFinal"] !== true) continue;
    next = Math.max(next, index + 1);
    if (index < floor || seen.has(id)) continue;
    seen.add(id);
    const line = lineFromRow(row);
    if (line) lines.push(line);
  }
  while (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return { lines, nextIndex: next };
}

// ---- What the person types ----

/** A person's own messages in the recording's threads, read through the room id the phone reads. */
export function typedQuery(recordingID: string): object {
  return {
    agentResponses: {
      $: {
        where: { roomID: roomIDForRecording(recordingID), authorKind: "person" },
        order: { createdAtMs: "desc" },
        limit: 8,
        fields: ["threadID", "text", "createdAtMs"],
      },
    },
  };
}

/** Messages not handed over yet, oldest first. Anything before `sinceMs` was there before the watch began. */
export function typedLines(rows: readonly Row[], seen: Set<string>, sinceMs: number): string[] {
  const fresh = rows.filter((row) => (num(row["createdAtMs"]) ?? 0) >= sinceMs && !seen.has(String(row["id"])));
  for (const row of fresh) seen.add(String(row["id"]));
  while (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return fresh
    .sort((a, b) => (num(a["createdAtMs"]) ?? 0) - (num(b["createdAtMs"]) ?? 0))
    .map((row) => `» [typed] thread ${String(row["threadID"])}: ${oneLine(String(row["text"] ?? ""))}`);
}

// ---- Batches: an agent reads a thought, not a word at a time ----

export interface BatchTimes {
  quietMs: number;
  longestMs: number;
}
/** About 5 s after the speaker pauses, or every 30 s while speech goes on. */
export const BALANCED: BatchTimes = { quietMs: 5_000, longestMs: 30_000 };
export const REALTIME: BatchTimes = { quietMs: 0, longestMs: 0 };

export interface Batch {
  lines: Line[];
  firstAtMs: number | null;
  lastAtMs: number | null;
}

export const emptyBatch = (): Batch => ({ lines: [], firstAtMs: null, lastAtMs: null });

export function addLines(batch: Batch, lines: readonly Line[], nowMs: number): Batch {
  if (lines.length === 0) return batch;
  return { lines: [...batch.lines, ...lines], firstAtMs: batch.firstAtMs ?? nowMs, lastAtMs: nowMs };
}

export function isDue(batch: Batch, nowMs: number, times: BatchTimes): boolean {
  if (batch.firstAtMs === null || batch.lastAtMs === null) return false;
  return nowMs - batch.lastAtMs >= times.quietMs || nowMs - batch.firstAtMs >= times.longestMs;
}

export function takeBatch(batch: Batch): { header: string; lines: Line[]; cursor: number } {
  const first = batch.lines[0]?.index ?? 0;
  const last = batch.lines.at(-1)?.index ?? first;
  const span = first === last ? `#${first}` : `#${first}-${last}`;
  return { header: `» ${span} (cursor ${last + 1}):`, lines: batch.lines, cursor: last + 1 };
}

// ---- Which recording is live ----

export const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The newest recording stamped active and written within six hours. A stamp older than that is a device that died. */
export function chooseCurrent(rows: readonly Row[], nowMs: number): Row | null {
  const live = rows.filter((row) => row["activityKind"] === "active" && (num(row["updatedAtMs"]) ?? 0) >= nowMs - LIVE_WINDOW_MS);
  live.sort((a, b) => (num(b["startedAtMs"]) ?? 0) - (num(a["startedAtMs"]) ?? 0));
  return live[0] ?? null;
}

// ---- Answers ----

export function roomIDForRecording(recordingID: string): string {
  const hex = createHash("sha256").update(`room|${recordingID.trim().toLowerCase()}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A stable UUID from parts, so posting the same answer twice writes the same rows. */
export function stableUUID(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("|")).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const MAXIMUM_ANSWER_BYTES = 4_000;
const MAXIMUM_PROMPT_CHARACTERS = 500;

export interface WriteStep {
  namespace: string;
  id: string;
  attrs: Row;
}

export interface AnswerRequest {
  recordingID: string;
  userID: string;
  line: Line;
  text: string;
  agent: string;
  nowMs: number;
  threadExists: boolean;
  responseExists: boolean;
}

/** The two rows of an answer. Each names its recording, which is what lets the recording's owner write it.
 *  A row keeps its creation time for life (the rules refuse a change), so a thread that exists gets only its status,
 *  and an answer that exists gets no write at all: posting twice is safe. */
export function planAnswer(request: AnswerRequest): Parsed<{ threadID: string; responseID: string; steps: WriteStep[] }> {
  const text = request.text.trim();
  const bytes = Buffer.byteLength(text);
  if (bytes === 0) return { ok: false, error: "an answer needs text" };
  if (bytes > MAXIMUM_ANSWER_BYTES) {
    return { ok: false, error: `the answer is ${bytes} bytes; the phone keeps ${MAXIMUM_ANSWER_BYTES}. Split it into several answers.` };
  }
  const recordingID = request.recordingID.trim().toLowerCase();
  const roomID = roomIDForRecording(recordingID);
  const { threadID, responseID } = answerIDs(recordingID, request.line.id, text);
  if (request.responseExists) return { ok: true, value: { threadID, responseID, steps: [] } };
  const listenerID = stableUUID(ID_NAMESPACE, "listener", roomID, request.agent.toLowerCase());
  const shared = { recordingID, roomID, listenerID, authorKind: "agent", authorUserID: request.userID, createdAtMs: request.nowMs, updatedAtMs: request.nowMs };
  const thread: WriteStep = {
    namespace: "agentThreads",
    id: threadID,
    attrs: request.threadExists
      ? { status: "answered", updatedAtMs: request.nowMs }
      : {
          ...shared,
          sourceSegmentID: request.line.id.toLowerCase(),
          origin: "transcript",
          prompt: oneLine(request.line.text).slice(0, MAXIMUM_PROMPT_CHARACTERS) || "(no prompt)",
          status: "answered",
        },
  };
  const response: WriteStep = {
    namespace: "agentResponses",
    id: responseID,
    attrs: {
      ...shared,
      threadID,
      kind: "answer",
      text,
      status: "ready",
      visibility: "revealed",
      speechStatus: "idle",
      providerResponseID: `${TOOL};agent=${encodeURIComponent(request.agent)};kind=answer`,
    },
  };
  return { ok: true, value: { threadID, responseID, steps: [thread, response] } };
}

/** The ids of a line's answer, so a caller can look them up before planning the write. */
export function answerIDs(recordingID: string, lineID: string, text: string): { threadID: string; responseID: string } {
  const recording = recordingID.trim().toLowerCase();
  return { threadID: stableUUID(ID_NAMESPACE, "thread", recording, lineID), responseID: stableUUID(ID_NAMESPACE, "response", recording, lineID, text.trim()) };
}

// ---- Arguments ----

const VALUE_FLAGS = new Set(["recording", "cursor", "cursor-file", "mode", "segment", "agent", "email", "code", "language"]);
const SWITCHES = new Set(["json", "jsonl", "version", "models", "no-models", "no-speakers"]);
const HELP = new Set(["--help", "-h"]);

export interface Arguments {
  command: string;
  flags: Record<string, string | true>;
  words: string[];
}

/** Asking for help is never an error: with --help or -h anywhere on the line, what is wrong with the rest does not matter,
 *  and a flag waiting for its value never takes them for it. */
export function parseArgs(argv: readonly string[]): Arguments {
  const asksForHelp = argv.some((argument) => HELP.has(argument));
  const flags: Record<string, string | true> = asksForHelp ? { help: true } : {};
  const words: string[] = [];
  let command = "";
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i] ?? "";
    if (HELP.has(argument)) continue;
    if (argument.startsWith("--")) {
      const name = argument.slice(2);
      if (SWITCHES.has(name)) {
        flags[name] = true;
      } else if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined || HELP.has(value)) {
          if (!asksForHelp) throw new Error(`--${name} needs a value`);
          continue;
        }
        flags[name] = value;
        i += 1;
      } else if (!asksForHelp) {
        throw new Error(`unknown option --${name}`);
      }
    } else if (command === "") {
      command = argument;
    } else {
      words.push(argument);
    }
  }
  return { command, flags, words };
}

// ---- How this program can be run from here ----

export interface Surroundings {
  /** $PATH of the shell that ran it. */
  path: string;
  execPath: string;
  home: string;
  isExecutable: (file: string) => boolean;
}

/** The words that run this program from here, for everything it tells a person or an agent to run. An installer cannot
 *  change the PATH of the terminal that started it, and a coding agent's shell may be just as old, so until the program is
 *  on PATH it names itself by its path. Run from source, the program is node or bun, and the plain name stands. */
export function runnableName(tool: string, here: Surroundings): string {
  if (here.path.split(":").some((folder) => folder !== "" && here.isExecutable(`${folder}/${tool}`))) return tool;
  if (!here.execPath.endsWith(`/${tool}`)) return tool;
  const fromHome = here.execPath.startsWith(`${here.home}/`) ? here.execPath.slice(here.home.length + 1) : null;
  const safe = /^[\w./-]+$/;
  if (fromHome !== null) return safe.test(fromHome) ? `~/${fromHome}` : `"$HOME/${fromHome}"`;
  return safe.test(here.execPath) ? here.execPath : `"${here.execPath}"`;
}
