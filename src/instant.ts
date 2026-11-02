// The one file that talks to Instant. Everything here runs as the signed-in person, with that person's own refresh
// token and no admin token, so the server's rules decide what it may read and write. Keeping the server behind this one
// file also means a change of server is a change here and nowhere else.

import { init } from "@instantdb/admin";
import { init as initLive, StoreInterface } from "@instantdb/core";

import type { Credential } from "./keychain.ts";
import { shouldReopen, typedQuery, windowQuery, type Row, type WriteStep } from "./core.ts";
import { APP_ID, INSTANT_API, TOOL } from "./names.ts";

const BOUND_MS = 5_000;

export class Refused extends Error {}

function within<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within 5 s. Check the network, then run: ${TOOL} doctor`)), BOUND_MS);
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

export function describe(error: unknown): string {
  const e = error as { body?: { message?: string }; message?: string } | null;
  return String(e?.body?.message ?? e?.message ?? error).slice(0, 300);
}

async function post(path: string, body: object): Promise<Row> {
  const response = await fetch(`${INSTANT_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BOUND_MS),
  });
  const json = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) throw new Error(String(json["message"] ?? `HTTP ${response.status}`));
  return json;
}

export async function sendCode(email: string): Promise<void> {
  await post("/runtime/auth/send_magic_code", { "app-id": APP_ID, email });
}

export async function verifyCode(email: string, code: string): Promise<Credential> {
  const result = await post("/runtime/auth/verify_magic_code", { "app-id": APP_ID, email, code });
  const user = result["user"] as Row | undefined;
  const userID = user?.["id"];
  const refreshToken = user?.["refresh_token"];
  if (typeof userID !== "string" || typeof refreshToken !== "string") throw new Error("the sign-in returned no account");
  return { userID, refreshToken, email };
}

const client = (credential: Credential) => init({ appId: APP_ID }).asUser({ token: credential.refreshToken });
type Client = ReturnType<typeof client>;
const query = (db: Client, what: string, q: object): Promise<Row> => within(what, db.query(q as never) as Promise<Row>);

const RECORDING_FIELDS = ["title", "activityKind", "startedAtMs", "updatedAtMs", "durationSeconds"];

/** The newest recordings this account may read. No owner filter: the rules show its own, a linked guest's included. */
export async function listRecordings(credential: Credential, limit = 8): Promise<Row[]> {
  const result = await query(client(credential), "reading recordings", { recordings: { $: { order: { startedAtMs: "desc" }, limit, fields: RECORDING_FIELDS } } });
  return (result["recordings"] ?? []) as Row[];
}

export async function readLine(credential: Credential, recordingID: string, index: number): Promise<Row | null> {
  const result = await query(client(credential), "reading the line", {
    transcriptionSegments: { $: { where: { recordingID, segmentIndex: index }, limit: 8 } },
  });
  const rows = (result["transcriptionSegments"] ?? []) as Row[];
  return rows.find((row) => row["retiredAtMs"] == null) ?? null;
}

/** Which of an answer's two rows are already written. */
export async function existingAnswer(credential: Credential, threadID: string, responseID: string): Promise<{ thread: boolean; response: boolean }> {
  const result = await query(client(credential), "reading the thread", {
    agentThreads: { $: { where: { id: threadID }, fields: ["status"] } },
    agentResponses: { $: { where: { id: responseID }, fields: ["status"] } },
  });
  return { thread: ((result["agentThreads"] ?? []) as Row[]).length > 0, response: ((result["agentResponses"] ?? []) as Row[]).length > 0 };
}

export async function write(credential: Credential, steps: readonly WriteStep[]): Promise<void> {
  const db = init({ appId: APP_ID });
  const chunks = steps.map((step) => (db.tx as unknown as Record<string, Record<string, { update(attrs: Row): never }>>)[step.namespace]![step.id]!.update(step.attrs));
  try {
    await within("posting the answer", db.asUser({ token: credential.refreshToken }).transact(chunks));
  } catch (error) {
    const reason = describe(error);
    if (/permission denied/i.test(reason)) throw new Refused(`the server refused the write: ${reason}. This account may only write to its own recordings.`);
    throw error;
  }
}

// ---- Live ----
//
// Live reads go over the WebSocket, one-shot reads and writes over HTTP. The admin SDK's stream restates the app's whole
// attribute catalog on every refresh: measured 796 KB per new line, with 2 KB of it the line. The WebSocket sends the
// catalog once per connection and then only the result: 2 to 7 KB per line over the same window.

/** The live client keeps nothing on disk: a restart reads again from the server. */
class MemoryStore extends StoreInterface {
  private readonly items = new Map<string, unknown>();
  async getItem(key: string): Promise<unknown> {
    return this.items.get(key) ?? null;
  }
  async setItem(key: string, value: unknown): Promise<void> {
    this.items.set(key, value);
  }
  async getAllKeys(): Promise<string[]> {
    return [...this.items.keys()];
  }
  async multiSet(pairs: Array<[string, unknown]>): Promise<void> {
    for (const [key, value] of pairs) this.items.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.items.delete(key);
  }
}

/** No window to tell us the network moved: the socket's own close is what starts a reconnect. */
class AlwaysOnline {
  static async getIsOnline(): Promise<boolean> {
    return true;
  }
  static listen(): () => void {
    return () => undefined;
  }
}

interface Subscribing {
  subscribeQuery(query: never, callback: (result: { data?: Row; error?: { message?: string } }) => void): () => void;
  auth: { signInWithToken(token: string): Promise<unknown> };
}

export type LiveClient = Subscribing;

export async function openLive(credential: Credential): Promise<LiveClient> {
  // The core client stays inert unless a window exists. It uses nothing else of a browser: storage and network come in.
  (globalThis as { window?: unknown }).window ??= globalThis;
  const db = initLive({ appId: APP_ID }, MemoryStore as never, AlwaysOnline) as unknown as Subscribing;
  await within("signing in to the live stream", db.auth.signInWithToken(credential.refreshToken));
  return db;
}

export interface Live {
  close(): void;
}

function subscribe(db: LiveClient, q: object, onData: (data: Row) => void, onNotice: (message: string) => void): () => void {
  return db.subscribeQuery(q as never, (result) => {
    if (result.error) onNotice(`the live query failed: ${describe(result.error)}`);
    else if (result.data) onData(result.data);
  });
}

/** The newest recordings, live. Its rows are few and small, so the phone's duration writes cost little. */
export function followRecordings(db: LiveClient, onRows: (rows: Row[]) => void, onNotice: (message: string) => void): Live {
  const q = { recordings: { $: { order: { startedAtMs: "desc" }, limit: 3, fields: RECORDING_FIELDS } } };
  return { close: subscribe(db, q, (data) => onRows((data["recordings"] ?? []) as Row[]), onNotice) };
}

export function followTyped(db: LiveClient, recordingID: string, onRows: (rows: Row[]) => void, onNotice: (message: string) => void): Live {
  return { close: subscribe(db, typedQuery(recordingID), (data) => onRows((data["agentResponses"] ?? []) as Row[]), onNotice) };
}

/** How often the window is also read over HTTP. A socket that died without closing delivers nothing and says nothing, so
 *  this read is what proves the path; it hands over anything the socket missed, and says so. */
const CATCH_UP_MS = 30_000;

/**
 * A recording's lines from `start`, through a window that moves forward. `onRows` returns the next line to expect; once
 * half the window is used it reopens further on, so a refresh never grows with the recording.
 */
export function followLines(db: LiveClient, credential: Credential, recordingID: string, start: number, onRows: (rows: Row[]) => number, onNotice: (message: string) => void): Live {
  let openedAt = start;
  let next = start;
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  const rowsOf = (data: Row): Row[] => (data["transcriptionSegments"] ?? []) as Row[];
  const open = (): void => {
    unsubscribe?.();
    openedAt = next;
    unsubscribe = subscribe(db, windowQuery(recordingID, next), (data) => {
      if (closed) return;
      next = onRows(rowsOf(data));
      if (shouldReopen(openedAt, next)) queueMicrotask(open);
    }, onNotice);
  };
  open();
  const catchUp = setInterval(() => {
    const before = next;
    void query(client(credential), "catching up", windowQuery(recordingID, next)).then(
      (data) => {
        if (closed) return;
        next = onRows(rowsOf(data));
        if (next > before) onNotice(`the live stream missed ${next - before} line(s); handed over now`);
      },
      (error: unknown) => onNotice(describe(error)),
    );
  }, CATCH_UP_MS);
  return {
    close() {
      closed = true;
      clearInterval(catchUp);
      unsubscribe?.();
    },
  };
}
