import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RunJournal, JOURNAL_SCHEMA_VERSION, type RunJournalOptions } from "../.pi/agent/extensions/planner-builder/run-journal.ts";
import { type ControlRecord } from "../.pi/agent/extensions/planner-builder/build-state.ts";

async function fixture(t: TestContext, options: Partial<RunJournalOptions> = {}): Promise<RunJournal> {
  const root = await mkdtemp(join(tmpdir(), "build-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await RunJournal.open({ runDirectory: join(root, "run"), runId: "run", sourceRoots: [], protectedPaths: [], ...options });
  t.after(() => journal.close().catch(() => {}));
  return journal;
}
function control(controlId: string, status: ControlRecord["status"] = "accepted"): ControlRecord {
  return { runId: "run", taskId: "T01", attemptId: "a1", controlId, status, origin: "manual", reason: "Run the focused tests", evidenceSequences: [1, 2], createdAt: 10, updatedAt: 11 };
}
async function records(journal: RunJournal): Promise<Record<string, any>[]> {
  return (await readFile(journal.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("serialized JSONL appends preserve call order, versions and restrictive permissions", async (t) => {
  const journal = await fixture(t, { write: async (handle, line) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await handle.writeFile(line);
    await handle.sync();
  } });
  await Promise.all(Array.from({ length: 20 }, (_, index) => journal.recordDecision({ origin: "runner", reason: `decision-${index}`, evidenceSequences: [index + 1] })));
  const lines = await records(journal);
  assert.deepEqual(lines.map((record) => record.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(lines.map((record) => record.reason.text), Array.from({ length: 20 }, (_, index) => `decision-${index}`));
  assert.ok(lines.every((record) => record.schemaVersion === JOURNAL_SCHEMA_VERSION && record.runId === "run"));
  assert.equal((await stat(journal.path)).mode & 0o777, 0o600);
  assert.equal((await stat(journal.runDirectory)).mode & 0o777, 0o700);
  assert.equal(journal.status.bytesWritten, (await stat(journal.path)).size);
});

test("controls persist explicit outcomes and bounded evidence, never arbitrary transcript properties", async (t) => {
  const journal = await fixture(t);
  const accepted = { ...control("c1"), reason: "雪".repeat(10000), evidenceSequences: Array.from({ length: 10000 }, (_, index) => index + 1), transcript: "SECRET TRANSCRIPT", thinking: "SECRET THINKING" };
  await journal.recordControl(accepted);
  await journal.recordControl({ ...accepted, status: "queued", updatedAt: 12 });
  await journal.recordControl({ ...accepted, status: "delivered", updatedAt: 13 });
  const lines = await records(journal);
  assert.deepEqual(lines.map((line) => line.status), ["accepted", "queued", "delivered"]);
  assert.equal(lines[0].reason.truncated, true);
  assert.equal(lines[0].reason.originalBytes, 30000);
  assert.equal(lines[0].evidenceTruncated, true);
  assert.ok(lines[0].evidenceSequences.length <= 32);
  const text = await readFile(journal.path, "utf8");
  assert.doesNotMatch(text, /SECRET|\ufffd/);
  assert.equal(journal.status.bytesWritten, Buffer.byteLength(text));
  assert.ok(journal.status.bytesWritten > text.length);
  assert.equal(journal.status.pendingControls, 0);
  await assert.rejects(journal.recordControl({ ...control("c1"), status: "accepted", updatedAt: 14 }), /transition/i);
});

test("capacity is measured in UTF-8 bytes, refuses admission early, and reserves accepted terminal records", async (t) => {
  const journal = await fixture(t, { maxBytes: 8192, maxRecordBytes: 2048 });
  await journal.recordControl(control("c1"));
  await journal.recordControl(control("c2"));
  assert.equal(journal.status.reservedBytes, 4096);
  for (let index = 0; index < 100; index++) {
    try {
      await journal.recordDecision({ origin: "runner", reason: "雪".repeat(300), evidenceSequences: [] });
    } catch (error) {
      assert.match(String(error), /capacity/i);
      break;
    }
  }
  assert.equal(journal.status.canAcceptControls, false);
  assert.match(journal.status.disableReason!, /capacity/i);
  await assert.rejects(journal.recordControl(control("c3")), /capacity/i);
  await journal.recordControl({ ...control("c1", "delivery-unknown"), updatedAt: 15 });
  await journal.recordControl({ ...control("c2", "cancelled"), updatedAt: 16 });
  assert.equal(journal.status.reservedBytes, 0);
  assert.equal(journal.status.pendingControls, 0);
  assert.ok((await stat(journal.path)).size <= 8192);
  assert.equal(journal.status.bytesWritten, (await stat(journal.path)).size);
  assert.deepEqual((await records(journal)).slice(-2).map((record) => record.status), ["delivery-unknown", "cancelled"]);
});

test("journal write failures reject the accepted action and all queued writes; reservations remain visible", async (t) => {
  let calls = 0;
  const journal = await fixture(t, { write: async (handle, line) => {
    calls++;
    if (calls === 2) throw new Error("disk unavailable");
    await handle.writeFile(line);
    await handle.sync();
  } });
  await journal.recordControl(control("c1"));
  const results = await Promise.allSettled([
    journal.recordControl({ ...control("c1", "delivered"), updatedAt: 12 }),
    journal.recordDecision({ origin: "runner", reason: "not silently lost", evidenceSequences: [] }),
  ]);
  assert.ok(results.every((result) => result.status === "rejected" && /disk unavailable/.test(String(result.reason))));
  assert.equal(calls, 2);
  assert.equal(journal.status.pendingControls, 1);
  assert.match(journal.status.disableReason!, /disk unavailable/);
  await assert.rejects(journal.close(), /disk unavailable/);
});

test("reserved terminals remain encodable with oversized escaped reasons and evidence", async (t) => {
  const journal = await fixture(t, { maxBytes: 8192, maxRecordBytes: 2048 });
  await journal.recordControl(control("c1"));
  await journal.recordControl({ ...control("c1", "delivery-unknown"), updatedAt: 12, reason: "\u0000".repeat(10000), evidenceSequences: Array.from({ length: 10000 }, (_, index) => Number.MAX_SAFE_INTEGER - index) });
  const lines = await records(journal);
  assert.equal(lines[1].reason.truncated, true);
  assert.equal(lines[1].reason.originalBytes, 10000);
  assert.equal(lines[1].status, "delivery-unknown");
  for (const line of (await readFile(journal.path, "utf8")).trim().split("\n")) assert.ok(Buffer.byteLength(line + "\n") <= 2048);
});

test("partial append failure poisons the journal without attempting later accepted-control writes", async (t) => {
  const journal = await fixture(t, { write: async (handle, line) => {
    await handle.writeFile(line.slice(0, 10));
    throw new Error("partial append");
  } });
  await assert.rejects(journal.recordControl(control("c1")), /partial append/);
  const size = (await stat(journal.path)).size;
  await assert.rejects(journal.recordControl(control("c2")), /partial append/);
  assert.equal((await stat(journal.path)).size, size);
  assert.equal(journal.status.canAcceptControls, false);
});

test("mutating a caller's record after enqueue does not change durable identity", async (t) => {
  const journal = await fixture(t);
  const input = control("c1");
  const promise = journal.recordControl(input);
  input.controlId = "changed";
  input.evidenceSequences.push(99);
  await promise;
  assert.equal((await records(journal))[0].controlId, "c1");
  assert.deepEqual((await records(journal))[0].evidenceSequences, [1, 2]);
});

test("attempt identity can be recorded before a child has a session", async (t) => {
  const journal = await fixture(t);
  await journal.recordAttempt({ runId: "run", taskId: "T01", attemptId: "a1", attemptNumber: 1, workspacePath: "/source/workspace" });
  const [entry] = await records(journal);
  assert.equal(entry.kind, "attempt");
  assert.equal(entry.attemptId, "a1");
  assert.equal(entry.workspacePath, "/source/workspace");
  await assert.rejects(journal.recordAttempt({ runId: "other", taskId: "T01", attemptId: "a1", attemptNumber: 1, workspacePath: "/source/workspace" }), /run/i);
});

test("attempt and supervisor session mappings are written to the supplied external run directory", async (t) => {
  const journal = await fixture(t);
  await journal.recordSession({ runId: "run", taskId: "T01", attemptId: "a1", attemptNumber: 1, workspacePath: "/source/workspace", role: "builder", sessionId: "s1", sessionFile: join(journal.runDirectory, "builder.jsonl") });
  await journal.recordSession({ runId: "run", role: "supervisor", sessionId: "s2", sessionFile: join(journal.runDirectory, "supervisor.jsonl") });
  const lines = await records(journal);
  assert.equal(lines[0].attemptId, "a1");
  assert.equal(lines[0].sessionId, "s1");
  assert.equal(lines[1].role, "supervisor");
  await assert.rejects(journal.recordSession({ runId: "run", role: "supervisor", sessionId: "s3", sessionFile: "/source/session.jsonl" }), /run directory/i);
});

test("unsafe paths, symlinks, source roots, protected paths and reuse are rejected without overwriting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "build-journal-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const options = { runId: "run", sourceRoots: [source], protectedPaths: [join(root, "reports")] };
  await assert.rejects(RunJournal.open({ ...options, runDirectory: join(source, "run") }), /source|protected/i);
  await assert.rejects(RunJournal.open({ ...options, runDirectory: join(root, "reports", "run") }), /protected/i);
  await assert.rejects(RunJournal.open({ ...options, runDirectory: join(root, ".pi", "plans", "run") }), /protected/i);
  await symlink(source, join(root, "link"));
  await assert.rejects(RunJournal.open({ ...options, runDirectory: join(root, "link", "run") }), /symlink|source/i);
  await mkdir(join(source, ".jj"));
  await assert.rejects(RunJournal.open({ ...options, sourceRoots: [], runDirectory: join(source, "other") }), /checkout|source/i);
  const journal = await RunJournal.open({ ...options, runDirectory: join(root, "safe") });
  await journal.recordDecision({ origin: "runner", reason: "keep", evidenceSequences: [] });
  await journal.close();
  await assert.rejects(RunJournal.open({ ...options, runDirectory: join(root, "safe") }), /exist/i);
  assert.equal((await records(journal)).length, 1);
  await assert.rejects(journal.recordControl(control("late")), /closed/i);
});
