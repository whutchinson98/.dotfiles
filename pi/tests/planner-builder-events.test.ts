import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BuildState,
  boundedText,
  normalizeSupervisionConfig,
  reduceControl,
  SUPERVISION_LIMITS,
  serializeSnapshot,
  type AttemptIdentity,
  type ControlRecord,
} from "../.pi/agent/extensions/planner-builder/build-state.ts";

const identity: AttemptIdentity = { runId: "run", taskId: "T01", attemptId: "attempt-1" };
function setup(limits = {}): BuildState {
  const state = new BuildState("run", { limits });
  state.registerAttempt({ ...identity, attemptNumber: 1, workspacePath: "/workspace" }, 10);
  return state;
}
function usage(totalTokens: number): object {
  return { input: totalTokens - 2, output: 2, reasoning: 1, totalTokens, cost: { total: totalTokens / 100 } };
}
function assistant(timestamp: number, text = "final", tokens = 12, stopReason = "stop"): object {
  return { role: "assistant", timestamp, content: [{ type: "text", text }], usage: usage(tokens), stopReason };
}
function update(state: BuildState, type: string, fields = {}, at = 20): void {
  state.observeRpc(identity, { type: "message_update", assistantMessageEvent: { type, ...fields } }, at);
}

test("parent sequences increase, snapshots are immutable, and inspection does not make progress", () => {
  const state = setup();
  const before = state.inspectTask("T01");
  const first = state.observeRpc(identity, { type: "agent_start" }, 11);
  const second = state.observeRpc(identity, { type: "future_event", delta: "not text" }, 12);
  assert.ok(second.sequence > first.sequence);
  assert.equal(before.sequence, 1);
  assert.equal(before.lastTransportAt, null);
  assert.throws(() => { before.queues.steering = 90; }, TypeError);
  const snapshot = state.inspectTask("T01");
  assert.equal(snapshot.lastTransportAt, 12);
  assert.equal(snapshot.lastProgressAt, 10);
  assert.deepEqual(state.inspectTask("T01"), snapshot);
});

test("stale attempts and wrong runs cannot mutate the current attempt", () => {
  const state = setup();
  state.registerAttempt({ ...identity, attemptId: "attempt-2", attemptNumber: 2, workspacePath: "/workspace" }, 20);
  const before = state.inspectTask("T01");
  const stale = state.observeRpc(identity, { type: "agent_settled", aborted: true }, 30);
  assert.equal(stale.applied, false);
  assert.equal(stale.payload.kind, "stale");
  assert.deepEqual(state.inspectTask("T01"), before);
  assert.throws(() => state.observeRpc({ ...identity, runId: "other" }, { type: "agent_start" }, 31), /run/i);
});

test("opaque attempt identities cannot be reused and attempt history has a finite bound", () => {
  const state = setup({ maxAttemptsPerTask: 2 });
  state.registerAttempt({ ...identity, attemptId: "attempt-2", attemptNumber: 2, workspacePath: "/workspace" }, 20);
  assert.throws(() => state.registerAttempt({ ...identity, attemptNumber: 3, workspacePath: "/workspace" }, 30), /identity/i);
  assert.throws(() => state.registerAttempt({ ...identity, attemptId: "attempt-3", attemptNumber: 3, workspacePath: "/workspace" }, 30), /capacity/i);
});

test("only text blocks become assistant text; indexes and authoritative endings replace partials", () => {
  const state = setup();
  state.observeRpc(identity, { type: "message_start", message: assistant(100, "", 0, "pending") }, 11);
  update(state, "text_delta", { contentIndex: 2, delta: "third" });
  update(state, "thinking_delta", { contentIndex: 1, delta: "PRIVATE THOUGHT" }, 21);
  update(state, "toolcall_delta", { contentIndex: 3, delta: "PRIVATE ARGUMENTS" }, 22);
  update(state, "text_delta", { contentIndex: 0, delta: "first" }, 23);
  assert.equal(state.inspectTask("T01").assistantText.text, "first\nthird");
  update(state, "text_end", { contentIndex: 2, content: "replacement" }, 24);
  assert.equal(state.inspectTask("T01").assistantText.text, "first\nreplacement");
  state.observeRpc(identity, { type: "message_end", message: {
    ...assistant(100, "authoritative"), content: [{ type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "text", text: "authoritative" }],
  } }, 25);
  const snapshot = state.inspectTask("T01");
  assert.equal(snapshot.assistantText.text, "authoritative");
  assert.equal(snapshot.activity.thinkingBytes, 15);
  assert.equal(snapshot.activity.toolArgumentBytes, 17);
  assert.doesNotMatch(JSON.stringify(state.inspectBuild()), /PRIVATE/);
});

test("thinking, tool arguments, queue notifications and transport responses do not reset watchdog progress", () => {
  const state = setup();
  update(state, "thinking_delta", { contentIndex: 0, delta: "reasoning" }, 100);
  update(state, "toolcall_delta", { contentIndex: 1, delta: "{}" }, 101);
  state.observeRpc(identity, { type: "queue_update", steering: ["guidance"], followUp: [] }, 102);
  state.observeRpc(identity, { type: "response", command: "get_state", success: true, data: {} }, 103);
  assert.equal(state.inspectTask("T01").lastProgressAt, 10);
  assert.equal(state.inspectTask("T01").lastTransportAt, 103);
  state.observe(identity, { kind: "human-wait", waiting: true }, 104);
  assert.equal(state.inspectTask("T01").humanWait.since, 104);
  state.observe(identity, { kind: "human-wait", waiting: false }, 114);
  assert.equal(state.inspectTask("T01").humanWait.totalMs, 10);
  assert.equal(state.inspectTask("T01").lastTransportAt, 103);
});

test("stream usage is cumulative per message; finals, turn_end and agent_end never double count", () => {
  const state = setup();
  state.observeRpc(identity, { type: "message_start", message: assistant(100, "", 0, "pending") }, 11);
  for (const tokens of [5, 5, 10]) {
    state.observeRpc(identity, { type: "message_update", usage: usage(tokens), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x" } }, 12);
  }
  assert.equal(state.inspectTask("T01").usage.totalTokens, 10);
  const message = assistant(100, "done", 8);
  state.observeRpc(identity, { type: "message_end", message }, 13);
  state.observeRpc(identity, { type: "message_end", message }, 14);
  state.observeRpc(identity, { type: "turn_end", message, toolResults: [] }, 15);
  state.observeRpc(identity, { type: "agent_end", messages: [message] }, 16);
  assert.equal(state.inspectTask("T01").usage.totalTokens, 8);
  state.observeRpc(identity, { type: "message_start", message: assistant(101, "", 0, "pending") }, 17);
  state.observeRpc(identity, { type: "message_end", message: assistant(101, "next", 7) }, 18);
  assert.equal(state.inspectTask("T01").usage.totalTokens, 15);
  assert.equal(state.inspectTask("T01").usage.reasoning, 2);
});

test("retry, tool-result and compaction usage count once, and only settlement closes a logical run", () => {
  const state = setup();
  const failed = assistant(100, "", 4, "error");
  state.observeRpc(identity, { type: "message_end", message: failed }, 11);
  state.observeRpc(identity, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "overloaded" }, 12);
  assert.equal(state.inspectTask("T01").phase, "retrying");
  state.observeRpc(identity, { type: "agent_end", messages: [failed], willRetry: true }, 13);
  assert.notEqual(state.inspectTask("T01").phase, "settled");
  state.observeRpc(identity, { type: "auto_retry_end", success: true, attempt: 1 }, 14);
  state.observeRpc(identity, { type: "compaction_start", reason: "overflow" }, 15);
  const compact = { type: "compaction_end", result: { usage: usage(6), summary: "not evidence" }, willRetry: true };
  state.observeRpc(identity, compact, 16);
  state.observeRpc(identity, compact, 17);
  const tool = { role: "toolResult", toolCallId: "tool-1", toolName: "nested", content: [{ type: "text", text: "ok" }], usage: usage(5), timestamp: 102 };
  state.observeRpc(identity, { type: "message_end", message: tool }, 18);
  state.observeRpc(identity, { type: "message_end", message: tool }, 19);
  state.observeRpc(identity, { type: "message_end", message: assistant(103, "done", 7) }, 20);
  state.observeRpc(identity, { type: "agent_settled", aborted: false }, 21);
  assert.equal(state.inspectTask("T01").usage.totalTokens, 22);
  assert.equal(state.inspectTask("T01").phase, "settled");
  assert.equal(state.inspectTask("T01").outcome, "stop");
});

for (const outcome of ["length", "error", "aborted"]) {
  test(`final ${outcome} outcome remains visible at settlement`, () => {
    const state = setup();
    state.observeRpc(identity, { type: "message_end", message: assistant(1, "", 2, outcome) }, 11);
    state.observeRpc(identity, { type: "agent_settled", aborted: outcome === "aborted" }, 12);
    assert.equal(state.inspectTask("T01").outcome, outcome);
  });
}

test("byte limits preserve UTF-8 and bounded events, tools and blocks expose truncation", () => {
  assert.deepEqual(boundedText("雪雪雪", 7), { text: "雪雪", originalBytes: 9, truncated: true });
  const state = setup({ maxEvents: 4, maxEventBytes: 2000, textBytes: 64, evidenceBytes: 48, maxTools: 2, maxBlocks: 2 });
  state.observeRpc(identity, { type: "message_start", message: assistant(1, "", 0, "pending") }, 11);
  for (let index = 0; index < 20; index++) {
    update(state, "text_delta", { contentIndex: index, delta: "雪".repeat(1000) });
    state.observeRpc(identity, { type: "tool_execution_end", toolCallId: `t${index}`, toolName: "bash", result: { content: [{ type: "text", text: "雪".repeat(1000) }], details: { transcript: "private" } } }, 21);
  }
  const snapshot = state.inspectTask("T01");
  assert.ok(Buffer.byteLength(snapshot.assistantText.text) <= 64);
  assert.equal(snapshot.assistantText.truncated, true);
  assert.ok(snapshot.tools.length <= 2);
  assert.ok(snapshot.tools.every((tool) => Buffer.byteLength(tool.output.text) <= 48 && tool.output.truncated));
  const build = state.inspectBuild();
  assert.ok(build.events.length <= 4);
  assert.ok(build.eventBytes <= 2000);
  assert.ok(build.droppedEvents > 0);
  assert.ok(snapshot.droppedTools > 0);
  assert.ok(snapshot.droppedBlocks > 0);
  assert.doesNotMatch(JSON.stringify(build), /private/);
});

test("usage identity capacity fails visibly instead of pretending usage is complete", () => {
  const state = setup({ maxUsageEntries: 2 });
  for (let timestamp = 1; timestamp <= 3; timestamp++) state.observeRpc(identity, { type: "message_end", message: assistant(timestamp) }, 20);
  assert.equal(state.inspectTask("T01").usageComplete, false);
  assert.match(state.inspectTask("T01").disableReason!, /usage/i);
});

test("session mapping and total run usage survive an attempt replacement", () => {
  const state = setup();
  state.observeRpc(identity, { type: "response", command: "get_state", success: true, data: { sessionId: "s1", sessionFile: "/run/session.jsonl" } }, 11);
  state.observeRpc(identity, { type: "message_end", message: assistant(1) }, 12);
  assert.equal(state.inspectTask("T01").session?.sessionId, "s1");
  state.registerAttempt({ ...identity, attemptId: "attempt-2", attemptNumber: 2, workspacePath: "/workspace" }, 13);
  assert.equal(state.inspectBuild().usage.totalTokens, 12);
  assert.equal(state.inspectTask("T01").usage.totalTokens, 0);
});

test("control transitions preserve identity, reason, evidence and timestamps, not acceptance-as-delivery", () => {
  const proposed: ControlRecord = { ...identity, controlId: "c1", origin: "supervisor", status: "proposed", reason: "check tests", evidenceSequences: [1], createdAt: 10, updatedAt: 10 };
  const accepted = reduceControl(proposed, "accepted", 11);
  assert.equal(proposed.status, "proposed");
  const queued = reduceControl(accepted, "queued", 12);
  assert.equal(queued.status, "queued");
  const delivered = reduceControl(queued, "delivered", 13);
  assert.equal(delivered.createdAt, 10);
  assert.equal(delivered.updatedAt, 13);
  assert.deepEqual(delivered.evidenceSequences, [1]);
  assert.throws(() => reduceControl(delivered, "accepted", 14), /transition/i);
  assert.throws(() => reduceControl(accepted, "started", 9), /timestamp/i);
  assert.equal(reduceControl(accepted, "delivery-unknown", 14).status, "delivery-unknown");
});

test("duplicate message starts and updates cannot double-count or erase an authoritative final", () => {
  const state = setup();
  const start = { type: "message_start", message: assistant(100, "", 0, "pending") };
  state.observeRpc(identity, start, 11);
  state.observeRpc(identity, { type: "message_update", usage: usage(5), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } }, 12);
  state.observeRpc(identity, start, 13);
  assert.equal(state.inspectTask("T01").usage.totalTokens, 5);
  assert.equal(state.inspectTask("T01").assistantText.text, "hello");
  state.observeRpc(identity, { type: "message_end", message: assistant(100, "final", 8) }, 14);
  state.observeRpc(identity, start, 15);
  update(state, "text_delta", { contentIndex: 0, delta: "late" }, 16);
  assert.equal(state.inspectTask("T01").assistantText.text, "final");
  assert.equal(state.inspectTask("T01").usage.totalTokens, 8);
  assert.equal(state.inspectTask("T01").usageComplete, true);
});

test("capacity exhaustion still exposes authoritative text, errors and final outcomes", () => {
  const state = setup({ maxUsageEntries: 1 });
  state.observeRpc(identity, { type: "message_end", message: assistant(1) }, 11);
  state.observeRpc(identity, { type: "message_end", message: { ...assistant(2, "last", 9, "error"), errorMessage: "provider failed" } }, 12);
  assert.equal(state.inspectTask("T01").assistantText.text, "last");
  assert.equal(state.inspectTask("T01").outcome, "error");
  assert.equal(state.inspectTask("T01").error?.text, "provider failed");
});

test("parent observations own their data and late lifecycle events cannot reopen sealing", () => {
  const state = setup();
  const error = boundedText("original", 100);
  state.observe(identity, { kind: "error", error }, 11);
  error.text = "mutated";
  assert.equal(state.inspectTask("T01").error?.text, "original");
  state.observe(identity, { kind: "phase", phase: "sealing" }, 12);
  state.observeRpc(identity, { type: "auto_retry_start", attempt: 1 }, 13);
  state.observeRpc(identity, { type: "compaction_start", reason: "threshold" }, 14);
  assert.equal(state.inspectTask("T01").phase, "sealing");
});

test("retry attempts, compaction cancellation and tool durations remain explicit in snapshots", () => {
  const state = setup();
  state.observeRpc(identity, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100 }, 11);
  state.observeRpc(identity, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 200 }, 12);
  state.observeRpc(identity, { type: "auto_retry_end", attempt: 2, success: false, finalError: "unavailable" }, 13);
  assert.equal(state.inspectTask("T01").retries.count, 2);
  assert.equal(state.inspectTask("T01").retries.success, false);
  assert.equal(state.inspectTask("T01").retries.maxAttempts, 3);
  state.observeRpc(identity, { type: "compaction_start", reason: "threshold" }, 14);
  state.observeRpc(identity, { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 300 }, 15);
  state.observeRpc(identity, { type: "summarization_retry_attempt_start", source: "compaction" }, 16);
  assert.equal(state.inspectTask("T01").retries.attempt, 1);
  state.observeRpc(identity, { type: "compaction_end", reason: "threshold", aborted: true, willRetry: false }, 17);
  assert.equal(state.inspectTask("T01").compaction.aborted, true);
  assert.equal(state.inspectTask("T01").compaction.willRetry, false);
  state.observeRpc(identity, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", durationMs: 42, result: { content: [{ type: "text", text: "ok" }] } }, 18);
  state.observeRpc(identity, { type: "message_end", message: { role: "toolResult", timestamp: 100, toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }] } }, 19);
  assert.equal(state.inspectTask("T01").tools[0].durationMs, 42);
});

test("active controls cannot be evicted or carried into a replacement attempt", () => {
  const state = setup({ maxControls: 1 });
  const accepted: ControlRecord = { ...identity, controlId: "c1", origin: "manual", status: "accepted", reason: "check", evidenceSequences: [1], createdAt: 11, updatedAt: 11 };
  state.observe(identity, { kind: "control", control: accepted }, 11);
  assert.throws(() => state.observe(identity, { kind: "control", control: { ...accepted, controlId: "c2" } }, 12), /capacity/i);
  assert.throws(() => state.registerAttempt({ ...identity, attemptId: "a2", attemptNumber: 2, workspacePath: "/workspace" }, 13), /accepted controls/i);
  state.observe(identity, { kind: "control", control: { ...accepted, status: "cancelled", updatedAt: 14 } }, 14);
  state.observe(identity, { kind: "control", control: { ...accepted, controlId: "c2", createdAt: 15, updatedAt: 15 } }, 15);
  assert.equal(state.inspectTask("T01").droppedControls, 1);
});

test("usage-only entries deduplicate and review serialization has a visible UTF-8 byte bound", () => {
  const state = setup();
  const entry = { type: "entry_appended", entry: { type: "usage", id: "u1", usage: usage(7), transcript: "excluded" } };
  state.observeRpc(identity, entry, 11);
  state.observeRpc(identity, entry, 12);
  assert.equal(state.inspectBuild().usage.totalTokens, 7);
  const snapshot = serializeSnapshot(state.inspectBuild(), 500);
  assert.ok(Buffer.byteLength(snapshot.text) <= 500);
  assert.equal(snapshot.truncated, true);
  assert.doesNotMatch(snapshot.text, /excluded/);
});

test("supervision defaults off, finite settings clamp to exported ranges, malformed settings fail", () => {
  const config = normalizeSupervisionConfig();
  assert.equal(config.supervisionMode, "off");
  assert.equal(config.supervisorAgent, "supervisor");
  assert.equal(config.supervisionOptions.maxTokens, 200000);
  const clamped = normalizeSupervisionConfig({ supervisionMode: "steer", supervisionOptions: { intervalSeconds: -1, maxReviews: 1e9 } });
  assert.equal(clamped.supervisionOptions.intervalSeconds, SUPERVISION_LIMITS.optionRanges.intervalSeconds[0]);
  assert.equal(clamped.supervisionOptions.maxReviews, SUPERVISION_LIMITS.optionRanges.maxReviews[1]);
  for (const maxTokens of [NaN, Infinity, "12"]) assert.throws(() => normalizeSupervisionConfig({ supervisionOptions: { maxTokens } }), /finite/i);
  assert.throws(() => normalizeSupervisionConfig({ supervisionMode: "unknown" }), /mode/i);
});
