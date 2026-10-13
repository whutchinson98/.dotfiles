import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createQuestionQueue, handleRpcQuestion } from "../.pi/agent/extensions/planner-builder/question-queue.ts";
import { createSupervisorBridge, supervisorResponsePath, SUPERVISOR_TOOLS } from "../.pi/agent/extensions/planner-builder/supervisor-bridge.ts";

function start(id: string, args: unknown = {}, toolName = "inspect_build"): Record<string, unknown> {
  return { type: "tool_execution_start", toolCallId: id, toolName, args };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("bridge isolates tools, binds parent identity, hashes complete IDs and deduplicates", async (t) => {
  const identity = { runId: "parent", launchId: "supervisor-1" };
  const calls: unknown[] = [];
  const bridge = await createSupervisorBridge({ identity, dispatch: async (request, bound) => {
    calls.push([request.args, bound]);
    return { observed: true };
  } });
  t.after(() => bridge.dispose());
  identity.runId = "changed";
  assert.equal((await fs.stat(bridge.dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(bridge.extensionPath)).mode & 0o777, 0o600);
  const source = await fs.readFile(bridge.extensionPath, "utf8");
  assert.deepEqual(SUPERVISOR_TOOLS, ["inspect_build", "inspect_task", "steer_task", "request_user_decision"]);
  assert.doesNotMatch(source, /child_process|execSync|registerCommand|process\.env/);
  const ids = ["../../outside/a", ".._.._outside_a", "a/b", "a_b", "\ud800", "\ud801"];
  assert.equal(new Set(ids.map((id) => supervisorResponsePath(bridge.dir, id))).size, ids.length);
  for (const id of ids) {
    assert.equal(path.dirname(supervisorResponsePath(bridge.dir, id)), bridge.dir);
    await Promise.all([bridge.handleToolStart(start(id, { runId: "other-build" })), bridge.handleToolStart(start(id))]);
    const file = supervisorResponsePath(bridge.dir, id);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { ok: true, result: { observed: true } });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await bridge.handleToolStart(start(id));
  }
  assert.equal(calls.length, ids.length);
  assert.deepEqual(calls[0], [{ runId: "other-build" }, { runId: "parent", launchId: "supervisor-1" }]);
  assert.equal(await bridge.handleToolStart(start("bash", {}, "bash")), false);
  assert.equal(await bridge.handleToolStart({ type: "message_update" }), false);
});

test("generated extension executes only the four bridge tools and validates response files", async (t) => {
  const bridge = await createSupervisorBridge({ identity: { runId: "r", launchId: "s" }, dispatch: async () => ({ status: "observed" }) });
  t.after(() => bridge.dispose());
  const source = await fs.readFile(bridge.extensionPath, "utf8");
  // Exercise the emitted extension, replacing only the runtime's TypeBox import with a schema stub.
  const Type = Object.fromEntries(["Object", "String", "Integer", "Optional", "Array", "Union", "Literal"].map((name) => [name, (...args: unknown[]) => ({ name, args })]));
  const factory = new Function("createHash", "constants", "fs", "path", "delay", "Type", source.replace(/^import .*;\n/gm, "").replace("export default function", "return function"));
  const tools: any[] = [];
  factory(createHash, constants, fs, path, delay, Type)({ registerTool: (tool: unknown) => tools.push(tool) });
  assert.deepEqual(tools.map((tool) => tool.name), SUPERVISOR_TOOLS);
  assert.ok(tools.every((tool) => tool.executionMode === "sequential"));
  const pending = tools[0].execute("../../round-trip", {}, new AbortController().signal);
  await bridge.handleToolStart(start("../../round-trip"));
  assert.deepEqual(await pending, { content: [{ type: "text", text: '{"status":"observed"}' }], details: { status: "observed" } });
  await fs.writeFile(supervisorResponsePath(bridge.dir, "too-large"), "x".repeat(16 * 1024 + 1));
  await assert.rejects(tools[0].execute("too-large", {}), /size/);
  await fs.symlink(bridge.extensionPath, supervisorResponsePath(bridge.dir, "symlink"));
  await assert.rejects(tools[0].execute("symlink", {}), /ELOOP/);
  const abort = new AbortController();
  const cancelled = tools[0].execute("cancel", {}, abort.signal);
  abort.abort();
  await assert.rejects(cancelled, /cancelled/);
});

test("bridge validates bounds and publishes bounded errors instead of partial JSON", async (t) => {
  const bridge = await createSupervisorBridge({ identity: { runId: "r", launchId: "s" }, dispatch: async () => "é".repeat(20_000) });
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.handleToolStart(start("x".repeat(2048))), /ID/);
  await assert.rejects(bridge.handleToolStart(start("bad", [])), /object/);
  await assert.rejects(bridge.handleToolStart(start("large", { text: "é".repeat(8192) })), /size/);
  await bridge.handleToolStart(start("response"));
  const text = await fs.readFile(supervisorResponsePath(bridge.dir, "response"), "utf8");
  assert.ok(Buffer.byteLength(text) <= 16 * 1024);
  assert.match(JSON.parse(text).error, /size/);
  assert.ok((await fs.readdir(bridge.dir)).every((file) => !file.endsWith(".tmp")));
});

test("bridge cancellation joins dispatch before deleting private files and rejects excess work", async () => {
  const entered = deferred<void>();
  const joined = deferred<void>();
  let aborted = false;
  const bridge = await createSupervisorBridge({
    identity: { runId: "r", launchId: "s" }, maxOutstanding: 1,
    dispatch: async (_request, _identity, signal) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      entered.resolve();
      await joined.promise;
      return "late";
    },
  });
  const pending = bridge.handleToolStart(start("pending"));
  await entered.promise;
  await assert.rejects(bridge.handleToolStart(start("overflow")), /outstanding/);
  const disposal = bridge.dispose();
  assert.equal(aborted, true);
  assert.ok(await fs.stat(bridge.dir));
  joined.resolve();
  await Promise.all([pending, disposal, bridge.dispose()]);
  await assert.rejects(fs.stat(bridge.dir), { code: "ENOENT" });
  assert.equal(await bridge.handleToolStart(start("late")), false);
});

test("bridge times out cooperative dispatch and records duplicates for its entire lifetime", async (t) => {
  const bridge = await createSupervisorBridge({
    identity: { runId: "r", launchId: "s" }, timeoutMs: 10, maxRequests: 1,
    dispatch: async (_request, _identity, signal) => {
      await delay(1000, undefined, { signal });
    },
  });
  t.after(() => bridge.dispose());
  await bridge.handleToolStart(start("slow"));
  assert.match(JSON.parse(await fs.readFile(supervisorResponsePath(bridge.dir, "slow"), "utf8")).error, /timeout/);
  await bridge.handleToolStart(start("slow"));
  await assert.rejects(bridge.handleToolStart(start("new")), /request limit/);
});

test("individual bridge cancellation is bounded and publication failures surface to the parent", async (t) => {
  const entered = deferred<void>();
  const bridge = await createSupervisorBridge({ identity: { runId: "r", launchId: "s" }, dispatch: async (request, _identity, signal) => {
    if (request.toolCallId === "cancel") {
      entered.resolve();
      await delay(1000, undefined, { signal });
    }
    return "done";
  } });
  t.after(() => bridge.dispose());
  const pending = bridge.handleToolStart(start("cancel"));
  await entered.promise;
  bridge.cancel("cancel");
  await pending;
  assert.match(JSON.parse(await fs.readFile(supervisorResponsePath(bridge.dir, "cancel"), "utf8")).error, /cancelled/);
  await fs.mkdir(supervisorResponsePath(bridge.dir, "failure"));
  await assert.rejects(bridge.handleToolStart(start("failure")), /EISDIR/);
  assert.ok((await fs.readdir(bridge.dir)).every((file) => !file.endsWith(".tmp")));
});

test("questions serialize across owners, cancel queued and active questions, and join UI cleanup", async () => {
  const first = deferred<string | undefined>();
  const second = deferred<string | undefined>();
  const shown: string[] = [];
  const waiting: string[] = [];
  let activeSignal: AbortSignal | undefined;
  const queue = createQuestionQueue({
    interactive: true,
    show: async (question, signal) => {
      shown.push(question.id);
      activeSignal = signal;
      return question.id === "first" ? first.promise : second.promise;
    },
    onWaitingStart: (question) => { waiting.push(`start:${question.id}`); },
    onWaitingEnd: (question) => { waiting.push(`end:${question.id}`); },
  });
  const a = queue.ask({ owner: "builder", id: "first", method: "input", title: "First" });
  const b = queue.ask({ owner: "supervisor", id: "cancelled", method: "input", title: "Cancelled" });
  const c = queue.ask({ owner: "other", id: "second", method: "input", title: "Second" });
  await delay(0);
  assert.deepEqual(shown, ["first"]);
  queue.cancelOwner("supervisor");
  assert.equal((await b).status, "cancelled");
  queue.cancelOwner("builder");
  assert.equal((await a).status, "cancelled");
  assert.equal(activeSignal?.aborted, true);
  assert.deepEqual(shown, ["first"], "do not overlap a UI still cleaning up");
  first.resolve("ignored late answer");
  await delay(0);
  assert.deepEqual(shown, ["first", "second"]);
  second.resolve("");
  assert.deepEqual(await c, { status: "answered", value: "" });
  await queue.close();
  assert.deepEqual(waiting.filter((entry) => entry.startsWith("start:")).sort(), ["start:cancelled", "start:first", "start:second"]);
  assert.deepEqual(waiting.filter((entry) => entry.startsWith("end:")).sort(), ["end:cancelled", "end:first", "end:second"]);
});

test("unavailable UI is immediate, deadlines include queue time, and shutdown is cancellable", async () => {
  let calls = 0;
  const offline = createQuestionQueue({ interactive: false, show: async () => { calls++; return "unexpected"; } });
  assert.equal((await offline.ask({ owner: "a", id: "q", method: "input", title: "?" })).status, "unavailable");
  assert.equal(calls, 0);
  await offline.close();
  const queue = createQuestionQueue({ interactive: true, show: async (_question, signal) => {
    await delay(1000, undefined, { signal });
    return "late";
  } });
  const active = queue.ask({ owner: "a", id: "1", method: "input", title: "?", timeoutMs: 30 });
  const queued = queue.ask({ owner: "b", id: "2", method: "input", title: "?", timeoutMs: 5 });
  assert.equal((await queued).status, "timeout");
  assert.equal((await active).status, "timeout");
  const abort = new AbortController();
  const pending = queue.ask({ owner: "a", id: "3", method: "input", title: "?" }, abort.signal);
  abort.abort();
  assert.equal((await pending).status, "cancelled");
  await queue.close();
  assert.equal((await queue.ask({ owner: "a", id: "4", method: "input", title: "?" })).status, "cancelled");
});

test("question input/answer limits, duplicate admission and UI failures do not wedge the queue", async () => {
  const wait = deferred<string>();
  const queue = createQuestionQueue({ interactive: true, maxPending: 2, show: async (question) => {
    if (question.id === "wait") return wait.promise;
    if (question.id === "huge-answer") return "é".repeat(20_000);
    throw new Error("UI failed");
  } });
  const question = { owner: "a", id: "wait", method: "input" as const, title: "?" };
  const first = queue.ask(question);
  assert.match(JSON.stringify(await queue.ask(question)), /Duplicate/);
  const second = queue.ask({ ...question, id: "second" });
  assert.match(JSON.stringify(await queue.ask({ ...question, id: "full" })), /full/);
  wait.resolve("answer");
  assert.equal((await first).status, "answered");
  assert.equal((await second).status, "error");
  assert.equal((await queue.ask({ ...question, id: "huge-answer" })).status, "error");
  await assert.rejects(queue.ask({ ...question, title: "é".repeat(20_000) }), /size/);
  await assert.rejects(handleRpcQuestion(queue, "a", { type: "extension_ui_request", id: "invalid", method: "select", title: "?", options: [42] }), /options/);
  await queue.close();
});

test("RPC adapter preserves confirm false and empty/multiline values; notifications never block", async () => {
  const questions: unknown[] = [];
  const queue = createQuestionQueue({ interactive: true, show: async (question) => {
    questions.push(question);
    switch (question.method) {
      case "confirm": return false;
      case "input": return "";
      case "editor": return "  first\nsecond\n";
      case "select": return "Second";
    }
  } });
  for (const [method, expected] of [["confirm", { confirmed: false }], ["input", { value: "" }], ["editor", { value: "  first\nsecond\n" }], ["select", { value: "Second" }]] as const) {
    const response = await handleRpcQuestion(queue, "child", { type: "extension_ui_request", id: method, method, title: "?", options: ["First", "Second"], prefill: "old" });
    assert.deepEqual(response, { type: "extension_ui_response", id: method, ...expected });
  }
  for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
    assert.equal(await handleRpcQuestion(queue, "child", { type: "extension_ui_request", id: method, method }), undefined);
  }
  assert.equal(questions.length, 4);
  await queue.close();
  assert.deepEqual(await handleRpcQuestion(queue, "child", { type: "extension_ui_request", id: "closed", method: "confirm", title: "?" }), { type: "extension_ui_response", id: "closed", cancelled: true });
});
