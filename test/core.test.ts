import assert from "node:assert/strict";
import { test } from "node:test";

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
  roomIDForRecording,
  shouldReopen,
  stableUUID,
  takeBatch,
  typedLines,
  typedQuery,
  windowQuery,
} from "../src/core.ts";
import { ID_NAMESPACE, KEYCHAIN_SERVICE, TOOL } from "../src/names.ts";

const row = (index: number, fields: Record<string, unknown> = {}) => ({
  id: `line-${index}`,
  segmentIndex: index,
  startTimeSeconds: index * 5,
  wallClockStartedAtMs: 1_790_000_000_000 + index * 5000,
  speaker: 1,
  text: `words ${index}`,
  isFinal: true,
  ...fields,
});

test("a final line is read; a line still being said and a retired line are not", () => {
  assert.equal(lineFromRow(row(3))?.index, 3);
  assert.equal(lineFromRow(row(3, { isFinal: false })), null);
  assert.equal(lineFromRow(row(3, { retiredAtMs: 5 })), null);
});

test("a sealed line keeps its place and never carries words", () => {
  const line = lineFromRow(row(4, { text: "", wordsSeal: "voice", sealedWords: "sw1.x" }));
  assert.equal(line?.sealed, true);
  assert.equal(line?.text, "");
  assert.match(formatLine(line!), /#4 \[speaker 1\] \[sealed\]$/);
});

test("a line prints its time into the recording, its number, its speaker and its words", () => {
  const line = lineFromRow(row(720, { startTimeSeconds: 3725.4 }))!;
  assert.match(formatLine(line), / \+1:02:05 #720 \[speaker 1\] words 720$/);
  assert.match(formatLine({ ...line, speaker: null }), / #720 words 720$/);
});

test("a window asks for a bounded page from just before the next line", () => {
  const query = windowQuery("r1", 100) as { transcriptionSegments: { $: { where: Record<string, unknown>; limit: number } } };
  const $ = query.transcriptionSegments.$;
  assert.equal($.limit, 32);
  assert.deepEqual($.where, { recordingID: "r1", segmentIndex: { $gte: 92 } });
  const first = windowQuery("r1", 3) as typeof query;
  assert.deepEqual(first.transcriptionSegments.$.where, { recordingID: "r1", segmentIndex: { $gte: 0 } });
});

test("new lines come once, in order, and a line that lands late inside the window is still handed over", () => {
  const seen = new Set<string>();
  const first = newLines([row(2), row(1)], seen, 0, 0);
  assert.deepEqual(first.lines.map((l) => l.index), [1, 2]);
  assert.equal(first.nextIndex, 3);
  const again = newLines([row(1), row(2)], seen, first.nextIndex, 0);
  assert.deepEqual(again.lines, []);
  const late = newLines([row(0), row(1), row(2), row(3)], seen, first.nextIndex, 0);
  assert.deepEqual(late.lines.map((l) => l.index), [0, 3]);
  assert.equal(late.nextIndex, 4);
});

test("a restart never hands over a line below its cursor, though the window reads a little behind it", () => {
  const seen = new Set<string>();
  const result = newLines([row(92), row(99), row(100), row(101)], seen, 100, 100);
  assert.deepEqual(result.lines.map((l) => l.index), [100, 101]);
  assert.equal(result.nextIndex, 102);
});

test("a retired or unfinished row moves the cursor past it only when final", () => {
  const seen = new Set<string>();
  const result = newLines([row(0), row(1, { retiredAtMs: 9 }), row(2, { isFinal: false })], seen, 0, 0);
  assert.deepEqual(result.lines.map((l) => l.index), [0]);
  assert.equal(result.nextIndex, 2);
});

test("the window reopens once half of it is used, so one result never grows with the recording", () => {
  assert.equal(shouldReopen(100, 115), false);
  assert.equal(shouldReopen(100, 116), true);
});

test("the seen set stays bounded through a long recording", () => {
  const seen = new Set<string>();
  let next = 0;
  for (let i = 0; i < 5000; i += 1) next = newLines([row(i)], seen, next, 0).nextIndex;
  assert.equal(next, 5000);
  assert.ok(seen.size <= 256, `seen holds ${seen.size}`);
});

test("a batch is due after a pause, or after the longest wait while speech goes on", () => {
  let batch = addLines(emptyBatch(), [lineFromRow(row(0))!], 0);
  assert.equal(isDue(batch, 4_999, BALANCED), false);
  assert.equal(isDue(batch, 5_000, BALANCED), true);
  batch = addLines(batch, [lineFromRow(row(1))!], 4_000);
  assert.equal(isDue(batch, 8_999, BALANCED), false);
  batch = addLines(batch, [lineFromRow(row(2))!], 29_000);
  assert.equal(isDue(batch, 30_000, BALANCED), true);
  assert.equal(isDue(emptyBatch(), 1_000_000, BALANCED), false);
});

test("taking a batch names its lines and the cursor to come back with", () => {
  const batch = addLines(emptyBatch(), [lineFromRow(row(7))!, lineFromRow(row(8))!], 0);
  const taken = takeBatch(batch);
  assert.equal(taken.header, "» #7-8 (cursor 9):");
  assert.equal(taken.lines.length, 2);
  assert.equal(takeBatch(addLines(emptyBatch(), [lineFromRow(row(7))!], 0)).header, "» #7 (cursor 8):");
});

test("current is the newest recording stamped active within six hours; a stale stamp is not live", () => {
  const now = 100 * 3_600_000;
  const rows = [
    { id: "stale", activityKind: "active", startedAtMs: now, updatedAtMs: now - 7 * 3_600_000 },
    { id: "live", activityKind: "active", startedAtMs: now - 10, updatedAtMs: now - 1000 },
    { id: "idle", activityKind: "idle", startedAtMs: now - 20, updatedAtMs: now },
  ];
  assert.equal(chooseCurrent(rows, now)?.id, "live");
  assert.equal(chooseCurrent(rows.slice(0, 1), now), null);
});

test("room ids match the phone's: SHA-256 of room|<lowercased id>, first 16 bytes", () => {
  assert.equal(roomIDForRecording("ABC"), roomIDForRecording("abc"));
  assert.match(roomIDForRecording("abc"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("stable ids are version-5 shaped and repeat for the same parts", () => {
  assert.equal(stableUUID("a", "b"), stableUUID("a", "b"));
  assert.notEqual(stableUUID("a", "b"), stableUUID("a", "c"));
  assert.match(stableUUID("a"), /^.{8}-.{4}-5.{3}-[89ab].{3}-.{12}$/);
});

test("a person's typed messages come once, oldest first, and earlier ones are not replayed", () => {
  const seen = new Set<string>();
  const row = (id: string, createdAtMs: number) => ({ id, createdAtMs, threadID: "t1", text: `typed ${id}` });
  const first = typedLines([row("b", 300), row("a", 200), row("old", 50)], seen, 100);
  assert.deepEqual(first, ["» [typed] thread t1: typed a", "» [typed] thread t1: typed b"]);
  assert.deepEqual(typedLines([row("b", 300)], seen, 100), []);
});

test("typed messages are read through the room the phone uses, bounded", () => {
  const $ = (typedQuery("R1") as { agentResponses: { $: { where: Record<string, unknown>; limit: number } } }).agentResponses.$;
  assert.deepEqual($.where, { roomID: roomIDForRecording("r1"), authorKind: "person" });
  assert.equal($.limit, 8);
});

const answer = { recordingID: "R1", userID: "u1", line: lineFromRow(row(9))!, text: " Done. ", agent: "my-agent", nowMs: 1000, threadExists: false, responseExists: false };

test("an answer writes a thread and a response, each naming its recording, and nothing else", () => {
  const plan = planAnswer(answer);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(plan.value.steps.map((s) => s.namespace), ["agentThreads", "agentResponses"]);
  for (const step of plan.value.steps) {
    assert.equal(step.attrs["recordingID"], "r1");
    assert.equal(step.attrs["roomID"], roomIDForRecording("r1"));
    assert.equal(step.attrs["authorKind"], "agent");
    assert.equal(step.attrs["authorUserID"], "u1");
  }
  assert.equal(plan.value.steps[0]!.attrs["sourceSegmentID"], "line-9");
  assert.equal(plan.value.steps[1]!.attrs["text"], "Done.");
});

test("the same answer twice is the same rows; a second answer on a line joins its thread", () => {
  const one = planAnswer(answer);
  const two = planAnswer({ ...answer, nowMs: 2000 });
  const other = planAnswer({ ...answer, text: "Another." });
  assert.ok(one.ok && two.ok && other.ok);
  if (!one.ok || !two.ok || !other.ok) return;
  assert.equal(one.value.responseID, two.value.responseID);
  assert.equal(one.value.threadID, other.value.threadID);
  assert.notEqual(one.value.responseID, other.value.responseID);
});

test("a retried answer writes nothing: the rules refuse a row whose creation time moves", () => {
  const plan = planAnswer({ ...answer, threadExists: true, responseExists: true });
  assert.ok(plan.ok);
  if (plan.ok) assert.deepEqual(plan.value.steps, []);
});

test("a second answer on a line moves only the thread's status, never its identity", () => {
  const plan = planAnswer({ ...answer, text: "Another.", threadExists: true });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(plan.value.steps.map((s) => s.namespace), ["agentThreads", "agentResponses"]);
  assert.deepEqual(plan.value.steps[0]!.attrs, { status: "answered", updatedAtMs: 1000 });
  assert.equal(plan.value.steps[1]!.attrs["createdAtMs"], 1000);
});

test("an empty or oversized answer is refused with the reason", () => {
  const empty = planAnswer({ ...answer, text: "  " });
  assert.equal(empty.ok, false);
  const long = planAnswer({ ...answer, text: "x".repeat(4001) });
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.error, /4001 bytes/);
});

test("an answer's ids are the ones its plan writes", () => {
  const plan = planAnswer(answer);
  const ids = answerIDs("R1", "line-9", "Done.");
  assert.ok(plan.ok);
  if (plan.ok) assert.deepEqual(ids, { threadID: plan.value.threadID, responseID: plan.value.responseID });
});

test("the names say spotter: the command, its Keychain item and the tag on every answer", () => {
  assert.equal(TOOL, "spotter");
  assert.equal(KEYCHAIN_SERVICE, "xyz.pisspoursoftware.spotter");
  const plan = planAnswer(answer);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.value.steps[1]!.attrs["providerResponseID"], "spotter;agent=my-agent;kind=answer");
});

test("answers' ids come from a namespace of their own, so a later rename keeps posting twice safe", () => {
  assert.equal(ID_NAMESPACE, "spotter");
  assert.deepEqual(answerIDs("R1", "line-9", " Done. "), {
    threadID: stableUUID(ID_NAMESPACE, "thread", "r1", "line-9"),
    responseID: stableUUID(ID_NAMESPACE, "response", "r1", "line-9", "Done."),
  });
});

test("arguments: a command, flags with values, booleans, and the words", () => {
  const parsed = parseArgs(["reply", "--segment", "12", "--json", "Hello", "there"]);
  assert.equal(parsed.command, "reply");
  assert.equal(parsed.flags["segment"], "12");
  assert.equal(parsed.flags["json"], true);
  assert.deepEqual(parsed.words, ["Hello", "there"]);
  assert.equal(parseArgs(["--version"]).flags["version"], true);
  assert.equal(parseArgs(["watch", "--cursor-file", "/tmp/c"]).flags["cursor-file"], "/tmp/c");
  assert.throws(() => parseArgs(["watch", "--mode"]), /--mode needs a value/);
  assert.throws(() => parseArgs(["watch", "--nonsense"]), /unknown option --nonsense/);
});
