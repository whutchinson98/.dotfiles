import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RpcAgent,
  RpcCommandError,
  type RpcAgentOptions,
  type RpcClock,
  type RpcRecord,
  type RpcSpawn,
} from "../.pi/agent/extensions/planner-builder/rpc-agent.ts";

const fixture = fileURLToPath(new URL("./fixtures/planner-builder-rpc-child.mjs", import.meta.url));

function agent(t: TestContext, scenario = "normal", options: Partial<RpcAgentOptions> = {}): RpcAgent {
  const child = new RpcAgent({
    invocation: { command: process.execPath, args: [fixture, scenario] },
    cwd: process.cwd(),
    env: process.env,
    shutdown: { commandMs: 100, gracefulMs: 100, termMs: 100, killMs: 1000 },
    ...options,
  });
  t.after(async () => { await child.stop(); });
  return child;
}

function nextRecord(child: RpcAgent, type: string): Promise<RpcRecord> {
  return new Promise((resolve) => {
    const unsubscribe = child.onRecord((record) => {
      if (record.type !== type) return;
      unsubscribe();
      resolve(record);
    });
  });
}

test("split UTF-8, LF/CRLF and Unicode separators survive framing; unknown events remain observable", async (t) => {
  const child = agent(t);
  const record = nextRecord(child, "future_event");
  await child.request("split");
  assert.equal((await record).text, "a\u2028b\u2029c雪");
  assert.equal(child.failure, undefined);
});

test("one-byte chunks deterministically preserve multibyte code points and CRLF boundaries", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  const record = nextRecord(child, "future_event");
  const bytes = Buffer.from(JSON.stringify({ type: "future_event", text: "雪\u2028\u2029é" }) + "\r\n");
  for (const byte of bytes) fake.child.stdout.write(Buffer.from([byte]));
  assert.equal((await record).text, "雪\u2028\u2029é");
  fake.close();
  await child.closed;
});

test("requests correlate out-of-order replies and command failures do not poison the transport", async (t) => {
  const child = agent(t);
  const first = child.request("reorder");
  const second = child.request("reorder");
  assert.deepEqual((await second).data, { order: 2 });
  assert.deepEqual((await first).data, { order: 1 });
  await assert.rejects(child.request("unsuccessful"), RpcCommandError);
  await child.request("get_state");
  assert.equal(child.state.pendingRequests, 0);
});

test("prompt dispositions handle no-run commands and settlement before the command reply", async (t) => {
  const child = agent(t);
  const handled = await child.prompt("handled");
  assert.equal(handled.disposition, "handled");
  assert.equal(await handled.settled, null);
  const started = await child.promptAndWait("fast");
  assert.equal(started.disposition, "started");
  assert.equal(started.settlement?.generation, 1);
  assert.equal(child.state.isSettled, true);
  const queued = await child.promptAndWait("guidance", { streamingBehavior: "steer" });
  assert.equal(queued.disposition, "queued");
  assert.equal(queued.settlement?.generation, 2);
  assert.equal((await child.waitForSettled({ afterGeneration: 1 })).generation, 2);
  assert.equal(child.state.completionWaiters, 0);
  const independentSettlement = await child.promptAndWait("handled-settled");
  assert.equal(independentSettlement.disposition, "handled");
  assert.equal(independentSettlement.settlement, null);
});

test("retry and agent_end do not complete a logical run before agent_settled", async (t) => {
  const child = agent(t);
  const retry = nextRecord(child, "auto_retry_start");
  const prompt = await child.prompt("retry");
  let completed = false;
  void prompt.settled.then(() => { completed = true; });
  await retry;
  await child.request("get_state");
  assert.equal(completed, false);
  await child.request("settle");
  assert.equal((await prompt.settled)?.aborted, false);
});

test("UI work never blocks stdout, queues/state are independent, and notifications need no reply", async (t) => {
  let release: (value: { value: string }) => void = () => {};
  const work = new Promise<{ value: string }>((resolve) => { release = resolve; });
  const child = agent(t, "normal", { uiHandler: () => work });
  const uiReply = nextRecord(child, "ui_reply");
  const queue = nextRecord(child, "queue_update");
  const state = nextRecord(child, "session_info_changed");
  await child.request("ui");
  await child.request("get_state");
  assert.deepEqual((await queue).steering, ["guidance"]);
  assert.equal((await state).name, "test");
  assert.equal(child.state.pendingUi, 1);
  release({ value: "answer" });
  assert.deepEqual((await uiReply).reply, { type: "extension_ui_response", id: "dialog-0", value: "answer" });
});

test("unavailable UI is cancelled and stop cancels active UI before clear_queue then abort", async (t) => {
  const unavailable = agent(t);
  const fallback = nextRecord(unavailable, "ui_reply");
  await unavailable.request("ui");
  assert.equal(((await fallback).reply as RpcRecord).cancelled, true);

  let signal: AbortSignal | undefined;
  let started: () => void = () => {};
  const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
  const child = agent(t, "normal", {
    uiHandler: (_request, abortSignal) => {
      signal = abortSignal;
      started();
      return new Promise(() => {});
    },
  });
  const records: RpcRecord[] = [];
  child.onRecord((record) => { records.push(record); });
  await child.request("ui");
  await handlerStarted;
  const stopped = child.stop();
  assert.equal(stopped, child.stop());
  await assert.rejects(child.request("get_state"), /stopp/i);
  const result = await stopped;
  assert.equal(result.error, undefined);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(records.filter((record) => record.type === "command_seen").map((record) => record.command), ["ui", "clear_queue", "abort"]);
  assert.ok(records.find((record) => record.type === "ui_reply"));
  assert.ok(records.find((record) => record.type === "stdin_closed"));
});

for (const kind of ["json", "utf8", "partial", "large", "incomplete", "array", "missingType", "mismatch", "unknownId", "parse"]) {
  test(`protocol corruption fails visibly and rejects all work: ${kind}`, async (t) => {
    const child = agent(t, "normal", { limits: { recordBytes: 1024, incompleteBytes: 512 } });
    const waiting = assert.rejects(child.waitForSettled(), /RPC/);
    await assert.rejects(child.request("corrupt", { kind }), /RPC/);
    await waiting;
    assert.ok((await child.closed).error);
    assert.equal(child.state.pendingRequests, 0);
    assert.equal(child.state.completionWaiters, 0);
  });
}

test("unexpected exit rejects outstanding commands and completion waiters, retaining bounded stderr", async (t) => {
  const child = agent(t, "normal", { limits: { stderrBytes: 128 } });
  await child.request("stderr");
  assert.ok(Buffer.byteLength(child.stderr) <= 128);
  assert.equal(child.stderrTruncated, true);
  const waiting = assert.rejects(child.waitForSettled(), /exited/);
  await assert.rejects(child.request("exit"), /exited/);
  await waiting;
  const result = await child.closed;
  assert.equal(result.code, 23);
  assert.match(result.stderr, /diagnostic/);
});

test("startup failures reject work and finish cleanup", async (t) => {
  const child = agent(t, "normal", { invocation: { command: "/nonexistent/planner-builder-rpc", args: [] } });
  await assert.rejects(child.request("get_state"), /RPC/);
  assert.ok((await child.closed).error);
});

test("stalled clear_queue skips abort; shutdown escalates through process-group TERM/KILL while draining", async (t) => {
  const child = agent(t, "stalled");
  const commands: unknown[] = [];
  child.onRecord((record) => { if (record.type === "command_seen") commands.push(record.command); });
  await child.request("get_state");
  const term = nextRecord(child, "term_ignored");
  const result = await child.stop();
  await term;
  assert.deepEqual(commands, ["get_state", "clear_queue"]);
  assert.deepEqual(result.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(child.state.queuedWrites, 0);
});

test("descendants are killed even after the direct child has exited and closed its pipes", { skip: process.platform !== "linux" }, async (t) => {
  const child = agent(t, "descendant");
  const descendant = await nextRecord(child, "descendant");
  const pid = descendant.pid as number;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  await assert.rejects(child.request("orphan"), /exited/);
  const result = await child.closed;
  assert.deepEqual(result.signals, ["SIGTERM", "SIGKILL"]);
  // An orphan may remain a zombie until the container's init reaps it; it must not be running.
  let stat = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    if (!stat || stat.split(") ")[1].startsWith("Z")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(!stat || stat.split(") ")[1].startsWith("Z"), stat);
});

class ManualClock implements RpcClock {
  time = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  next = 0;
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }
  clearTimeout(id: unknown): void { this.timers.delete(id as number); }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of this.timers) {
      if (timer.at > this.time) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function fakeProcess(): {
  child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; pid?: number; kill: () => boolean };
  writes: RpcRecord[];
  release: () => void;
  send: (record: RpcRecord) => void;
  close: () => void;
} {
  const writes: RpcRecord[] = [];
  let release = () => {};
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(JSON.parse(chunk.toString()));
        release = callback;
      },
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() { close(); return true; },
  });
  function close(): void {
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  }
  return { child, writes, release: () => release(), send: (record) => { child.stdout.write(JSON.stringify(record) + "\n"); }, close };
}

function reply(record: RpcRecord): RpcRecord {
  return { type: "response", id: record.id, command: record.type, success: true };
}

test("stdin backpressure bounds writes without serializing response waits; injected invocation is exact", async () => {
  const fake = fakeProcess();
  const clock = new ManualClock();
  const child = new RpcAgent({
    invocation: { command: "fake", args: ["--mode", "rpc"] }, cwd: "/workspace", env: { ONLY: "explicit" },
    dependencies: {
      clock,
      spawn: ((command, args, options) => {
        assert.equal(command, "fake");
        assert.deepEqual(args, ["--mode", "rpc"]);
        assert.equal(options.cwd, "/workspace");
        assert.deepEqual(options.env, { ONLY: "explicit" });
        assert.equal(options.detached, process.platform !== "win32");
        assert.equal(options.shell, false);
        return fake.child;
      }) as RpcSpawn,
    },
  });
  const first = child.request("first");
  const second = child.request("second");
  assert.equal(fake.writes.length, 1);
  assert.equal(child.state.queuedWrites, 1);
  fake.release();
  assert.equal(fake.writes.length, 2);
  fake.send(reply(fake.writes[1]));
  await second;
  fake.send(reply(fake.writes[0]));
  await first;
  fake.close();
  await child.closed;
  assert.equal(clock.timers.size, 0);
  assert.equal(fake.child.stdout.listenerCount("data"), 0);
});

test("queued prompt completion is armed at write time, not at enqueue time", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  const blocked = child.request("first");
  const prompt = child.prompt("next");
  fake.send({ type: "agent_settled", aborted: false });
  fake.send(reply(fake.writes[0]));
  await blocked;
  fake.release();
  fake.send({ ...reply(fake.writes[1]), data: { disposition: "started" } });
  const accepted = await prompt;
  assert.equal(child.state.completionWaiters, 1);
  fake.send({ type: "agent_settled", aborted: false });
  assert.equal((await accepted.settled)?.generation, 2);
  fake.close();
  await child.closed;
});

test("a fresh run before prompt acceptance invalidates an earlier settled generation", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  const prompt = child.prompt("next");
  fake.send({ type: "agent_settled", aborted: false });
  fake.send({ type: "agent_start" });
  fake.send({ ...reply(fake.writes[0]), data: { disposition: "started" } });
  const accepted = await prompt;
  assert.equal(child.state.completionWaiters, 1);
  assert.equal(child.state.isSettled, false);
  fake.send({ type: "agent_settled", aborted: false });
  assert.equal((await accepted.settled)?.generation, 2);
  fake.close();
  await child.closed;
});

test("injected deadlines fail ambiguous requests and remove all timers", async () => {
  const fake = fakeProcess();
  const clock = new ManualClock();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { clock, spawn: (() => fake.child) as RpcSpawn } });
  const rejected = assert.rejects(child.request("never", {}, { timeoutMs: 10 }), /timed out/);
  clock.advance(10);
  await rejected;
  fake.close();
  await child.closed;
  assert.equal(clock.timers.size, 0);
});

test("stdin errors are terminal even with no response", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  const rejected = assert.rejects(child.request("first"), /stdin/);
  fake.child.stdin.emit("error", new Error("broken pipe"));
  await rejected;
  fake.close();
  await child.closed;
});

test("stop discards unsent prompts before writing clear_queue and abort", async () => {
  const fake = fakeProcess();
  const clock = new ManualClock();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { clock, spawn: (() => fake.child) as RpcSpawn } });
  const first = assert.rejects(child.request("first"), /stopping/);
  const queued = assert.rejects(child.prompt("never send this"), /stopping/);
  const stopped = child.stop();
  await Promise.all([first, queued]);
  fake.release();
  assert.equal(fake.writes[1].type, "clear_queue");
  fake.send(reply(fake.writes[1]));
  await Promise.resolve();
  fake.release();
  assert.equal(fake.writes[2].type, "abort");
  fake.send(reply(fake.writes[2]));
  await Promise.resolve();
  fake.release();
  fake.close();
  assert.equal((await stopped).error, undefined);
  assert.deepEqual(fake.writes.map((record) => record.type), ["first", "clear_queue", "abort"]);
  assert.equal(clock.timers.size, 0);
});

test("dialogs arriving during shutdown are cancelled even behind an uncooperative active handler", async (t) => {
  let started: () => void = () => {};
  const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
  const child = agent(t, "dialog-on-abort", {
    uiHandler: () => { started(); return new Promise(() => {}); },
  });
  const replies: RpcRecord[] = [];
  child.onRecord((record) => { if (record.type === "ui_reply") replies.push(record.reply as RpcRecord); });
  await child.request("ui");
  await handlerStarted;
  const stopped = await child.stop();
  assert.equal(stopped.error, undefined);
  assert.deepEqual(stopped.shutdownErrors, []);
  assert.deepEqual(replies.map((record) => [record.id, record.cancelled]), [["dialog-0", true], ["abort-dialog", true]]);
});

test("UI deadlines cancel active and queued dialogs without launching unbounded handlers", async () => {
  const fake = fakeProcess();
  const clock = new ManualClock();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const child = new RpcAgent({
    invocation: { command: "fake", args: [] }, cwd: ".", env: {},
    limits: { uiTimeoutMs: 10 }, dependencies: { clock, spawn: (() => fake.child) as RpcSpawn },
    uiHandler: (_request, abortSignal) => { calls++; signal = abortSignal; return new Promise(() => {}); },
  });
  fake.send({ type: "extension_ui_request", id: "one", method: "input" });
  fake.send({ type: "extension_ui_request", id: "two", method: "confirm" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  clock.advance(10);
  assert.equal(signal?.aborted, true);
  assert.equal(child.state.pendingUi, 0);
  fake.release();
  assert.deepEqual(fake.writes.map((record) => record.cancelled), [true, true]);
  assert.equal(child.replyUi("one", { value: "too late" }), false);
  fake.send({ type: "extension_ui_request", id: "three", method: "input" });
  await Promise.resolve();
  assert.equal(calls, 1);
  clock.advance(10);
  fake.close();
  await child.closed;
  assert.equal(clock.timers.size, 0);
});

test("UI overflow and duplicate in-flight IDs are visible protocol failures", async (t) => {
  const child = agent(t, "normal", { limits: { uiRequests: 1 }, uiHandler: () => new Promise(() => {}) });
  await assert.rejects(child.request("ui", { count: 2 }), /UI request limit/);
  await child.closed;
  const fake = fakeProcess();
  const duplicate = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  const record = { type: "extension_ui_request", id: "same", method: "input" };
  fake.send(record);
  fake.send(record);
  assert.match(duplicate.failure?.message ?? "", /duplicate UI/);
  fake.close();
  await duplicate.closed;
});

test("malformed prompt dispositions fail, and completion deadlines reject all pending work", async () => {
  const fake = fakeProcess();
  const clock = new ManualClock();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { clock, spawn: (() => fake.child) as RpcSpawn } });
  const prompt = assert.rejects(child.prompt("hello"), /disposition/);
  fake.send({ ...reply(fake.writes[0]), data: { disposition: "maybe" } });
  await prompt;
  fake.close();
  await child.closed;
  assert.equal(clock.timers.size, 0);

  const idleFake = fakeProcess();
  const idle = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { clock, spawn: (() => idleFake.child) as RpcSpawn } });
  const waiting = assert.rejects(idle.waitForSettled({ timeoutMs: 10 }), /settlement timed out/);
  const request = assert.rejects(idle.request("never"), /settlement timed out/);
  clock.advance(10);
  await Promise.all([waiting, request]);
  idleFake.close();
  await idle.closed;
  assert.equal(clock.timers.size, 0);
});

test("completion admission is bounded even after command responses free their slots", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, limits: { completionWaiters: 1 }, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  const prompt = child.prompt("first");
  fake.send({ ...reply(fake.writes[0]), data: { disposition: "started" } });
  const first = assert.rejects((await prompt).settled, /waiter limit/);
  assert.equal(child.state.pendingRequests, 0);
  await assert.rejects(child.prompt("second"), /waiter limit/);
  await first;
  fake.close();
  await child.closed;
});

test("record subscribers cannot start an unbounded queue of asynchronous callbacks", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  child.onRecord(async () => { throw new Error("observer rejected"); });
  fake.send({ type: "future_event" });
  assert.match(child.failure?.message ?? "", /must be synchronous/);
  fake.close();
  await child.closed;
});

test("UI handler failures cancel the dialog and fail visibly without unhandled rejections", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({
    invocation: { command: "fake", args: [] }, cwd: ".", env: {},
    dependencies: { spawn: (() => fake.child) as RpcSpawn },
    uiHandler: () => { throw new Error("UI unavailable"); },
  });
  const waiting = assert.rejects(child.waitForSettled(), /UI unavailable/);
  fake.send({ type: "extension_ui_request", id: "one", method: "input" });
  await waiting;
  assert.equal(fake.writes[0].cancelled, true);
  fake.close();
  await child.closed;
});

test("non-POSIX shutdown falls back to the direct child and still joins it", async () => {
  const fake = fakeProcess();
  const clock = new ManualClock();
  const child = new RpcAgent({
    invocation: { command: "fake", args: [] }, cwd: ".", env: {},
    shutdown: { commandMs: 10, gracefulMs: 10, termMs: 10, killMs: 10 },
    dependencies: {
      clock, platform: "win32",
      spawn: ((_command, _args, options) => { assert.equal(options.detached, false); return fake.child; }) as RpcSpawn,
      signalProcess: () => { assert.fail("must not signal a process group on Windows"); },
    },
  });
  const stopped = child.stop();
  clock.advance(10); // clear_queue deadline
  await Promise.resolve();
  clock.advance(10); // orderly EOF deadline
  await Promise.resolve();
  assert.deepEqual((await stopped).signals, ["SIGTERM"]);
  assert.equal(clock.timers.size, 0);
});

test("synchronous spawn errors and invalid bounds throw without starting a process", () => {
  const options: RpcAgentOptions = {
    invocation: { command: "fake", args: [] }, cwd: ".", env: {},
    dependencies: { spawn: () => { throw new Error("spawn failed"); } },
  };
  assert.throws(() => new RpcAgent(options), /spawn failed/);
  assert.throws(() => new RpcAgent({ ...options, limits: { recordBytes: Infinity } }), /positive finite/);
});

test("bytes and events still drain between unexpected exit and pipe close", async () => {
  const fake = fakeProcess();
  const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
  const final = nextRecord(child, "final_buffered_event");
  fake.child.emit("exit", 23, null);
  fake.send({ type: "final_buffered_event" });
  await final;
  fake.close();
  await child.closed;
});

for (const limits of [{ pendingRequests: 1 }, { queuedWrites: 1 }, { queuedWriteBytes: 50 }]) {
  test(`admission overflow is terminal and bounded: ${JSON.stringify(limits)}`, async () => {
    const fake = fakeProcess();
    const child = new RpcAgent({ invocation: { command: "fake", args: [] }, cwd: ".", env: {}, limits, dependencies: { spawn: (() => fake.child) as RpcSpawn } });
    const requests = [child.request("one"), child.request("two"), child.request("three")];
    const results = Promise.allSettled(requests);
    fake.close();
    assert.ok((await results).every((result) => result.status === "rejected"));
    assert.match(child.failure?.message ?? "", /limit/);
    await child.closed;
  });
}
