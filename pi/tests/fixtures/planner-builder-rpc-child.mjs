import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

const decoder = new StringDecoder("utf8");
const scenario = process.argv[2] ?? "normal";
let buffer = "";
let first;
let descendant;
let pendingAbort;

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (script?.audit) fs.appendFileSync(script.audit, JSON.stringify({ pid: process.pid, role, cwd: process.cwd(), ...record }) + "\n");
  if (sessionFile && record.type === "message_end") {
    fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), message: record.message }) + "\n");
  }
}

function response(command, data) {
  emit({ type: "response", id: command.id, command: command.type, success: true, data });
}

// The supervised fixture accepts data, never shell programs. All work and sessions
// stay in the disposable fixture directory; no Pi runtime/configuration is loaded.
const script = scenario === "supervised" ? JSON.parse(fs.readFileSync(process.argv[3], "utf8")) : undefined;
const role = process.env.PI_SUBAGENT_NAME ?? "builder";
function option(name) { return process.argv[process.argv.indexOf(name) + 1]; }
const sessionId = process.argv.includes("--session-id") ? option("--session-id") : randomUUID();
const sessionFile = script && process.argv.includes("--session-dir") ? path.join(option("--session-dir"), `${sessionId}.jsonl`) : undefined;
if (script) {
  const relative = path.relative(script.root, process.cwd());
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fake child must run inside its disposable fixture");
  if (sessionFile) fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() }) + "\n");
}
let streaming = false;
let compacting = false;
let guidance;
let heldReceipt;
let taskId = "T01";
let job;
let committed = false;
let messageNumber = 0;
let toolNumber = 0;
const reviewed = new Set();

function usage(tokens = 12) {
  return { input: tokens, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function assistant(text = "PLAN_TASK_RESULT: done", stopReason = "stop", tokens = 12) {
  const message = { role: "assistant", timestamp: ++messageNumber, content: [{ type: "text", text }], stopReason, usage: usage(tokens) };
  emit({ type: "message_start", message: { ...message, content: [], stopReason: "pending" } });
  emit({ type: "message_end", message });
  return message;
}
function settle(aborted = false) {
  streaming = false;
  emit({ type: "agent_end", messages: [], willRetry: false });
  emit({ type: "agent_settled", aborted });
}
function deliver() {
  if (!guidance) return;
  emit({ type: "queue_update", steering: [], followUp: [] });
  emit({ type: "message_end", message: { role: "user", content: guidance.message, timestamp: ++messageNumber } });
  guidance = undefined;
}
function commitTask() {
  if (!job || committed) return;
  for (const file of job.requires ?? []) {
    if (!fs.existsSync(path.resolve(file))) throw new Error(`Missing dependency file: ${file}`);
  }
  const files = job.files ?? { [`${taskId}.txt`]: `${taskId}\n` };
  for (const [file, content] of Object.entries(files)) {
    if (path.isAbsolute(file) || file.split("/").includes("..") || /(^|\/)\.(git|jj)(\/|$)/.test(file)) throw new Error("Unsafe fake task path");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  function vcs(args) { execFileSync(script.vcs, args, { cwd: process.cwd(), env, timeout: 10_000, stdio: "pipe" }); }
  if (script.vcs === "git") {
    vcs(["-c", "core.hooksPath=/dev/null", "add", "--", ...Object.keys(files)]);
    vcs(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", taskId]);
  } else vcs(["--no-pager", "commit", "-m", taskId]);
  committed = true;
}
function finish() {
  commitTask();
  assistant(`PLAN_TASK_RESULT: ${job?.result ?? "done"}`);
  settle();
}
async function bridgeTool(toolName, args) {
  const toolCallId = `fixture-${++toolNumber}`;
  emit({ type: "tool_execution_start", toolName, toolCallId, args });
  const directory = path.dirname(option("--extension"));
  const hash = createHash("sha256").update(JSON.stringify(toolCallId)).digest("hex");
  const file = path.join(directory, `${hash}.response.json`);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Fake supervisor bridge timeout");
    await delay(5);
  }
  const reply = JSON.parse(fs.readFileSync(file, "utf8"));
  emit({ type: "fixture_bridge_result", toolName, reply });
  emit({ type: "tool_execution_end", toolName, toolCallId, result: { content: [{ type: "text", text: JSON.stringify(reply) }] }, isError: !reply.ok });
  return reply.result;
}
async function review() {
  const view = await bridgeTool("inspect_build", {});
  for (const task of view.data.tasks) {
    if (reviewed.has(task.attemptId)) continue;
    reviewed.add(task.attemptId);
    if (script.supervisor?.action === "steer") {
      await bridgeTool("steer_task", { taskId: task.taskId, attemptId: task.attemptId,
        guidance: "Inspect retained work and preserve the single task commit.", reason: "Scripted acceptance checkpoint", evidenceSequences: [] });
    }
  }
  assistant("Reviewed scripted evidence; no other action.", "stop", script.supervisor?.tokens ?? 12);
  settle();
}
async function supervised(command) {
  emit({ type: "fixture_command", command });
  if (command.type === "get_state") {
    response(command, { sessionId, sessionFile, isStreaming: streaming, isCompacting: compacting, pendingMessageCount: guidance ? 1 : 0 });
  } else if (command.type === "get_session_stats") response(command, { tokens: { total: script.supervisor?.tokens ?? 14 } });
  else if (command.type === "prompt") {
    if (role === "supervisor") {
      streaming = true;
      emit({ type: "agent_start" });
      response(command, { disposition: "started" });
      await review();
    } else if (command.streamingBehavior) {
      guidance = command;
      const disposition = streaming ? "queued" : "started";
      if (!streaming) { streaming = true; emit({ type: "agent_start" }); }
      emit({ type: "queue_update", steering: [command.message], followUp: [] });
      if (script.holdReceipt) heldReceipt = { command, disposition };
      else response(command, { disposition });
      if (script.mode !== "manual") { deliver(); finish(); }
    } else {
      taskId = command.message.match(/Assigned task: (T\d+)/)?.[1] ?? "T01";
      job = script.jobs?.[taskId];
      streaming = true;
      emit({ type: "agent_start" });
      response(command, { disposition: "started" });
      if (script.mode === "exit") process.exit(23);
      if (script.mode === "question") emit({ type: "extension_ui_request", id: "decision", method: "input", title: "Choose a fixture value" });
      else if (script.mode === "auto") finish();
      else emit({ type: "tool_execution_start", toolName: "read", toolCallId: "working", args: { path: "local.txt" } });
    }
  } else if (command.type === "extension_ui_response") {
    emit({ type: "fixture_ui_reply", reply: command });
    if (!command.cancelled) finish();
  } else if (command.type === "clear_queue") {
    const steering = guidance ? [guidance.message] : [];
    guidance = undefined;
    if (steering.length) emit({ type: "queue_update", steering: [], followUp: [] });
    response(command, { steering, followUp: [] });
  } else if (command.type === "abort") {
    if (streaming) settle(true);
    response(command);
  } else if (command.type === "fixture") {
    switch (command.action) {
      case "finish": finish(); break;
      case "settle": settle(); break;
      case "deliver": deliver(); break;
      case "receipt": response(heldReceipt.command, { disposition: heldReceipt.disposition }); heldReceipt = undefined; break;
      case "retry":
        assistant("Transient fixture failure", "error");
        emit({ type: "agent_end", messages: [], willRetry: true });
        emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: "fixture retry" });
        compacting = true;
        emit({ type: "compaction_start", reason: "overflow" });
        break;
      case "recovered":
        compacting = false;
        emit({ type: "compaction_end", reason: "overflow", result: { usage: usage(5) }, aborted: false, willRetry: true });
        emit({ type: "auto_retry_end", success: true, attempt: 2 });
        break;
      case "deltas":
        emit({ type: "message_start", message: { role: "assistant", timestamp: ++messageNumber, content: [], stopReason: "pending" } });
        for (const [type, contentIndex, delta] of [["thinking_delta", 0, "PRIVATE_THINKING"], ["toolcall_delta", 1, "PRIVATE_ARGUMENT"], ["text_delta", 2, "Visible 雪\u2028text"]]) {
          emit({ type: "message_update", usage: usage(), assistantMessageEvent: { type, contentIndex, delta } });
        }
        break;
      case "pause": process.stdin.pause(); break;
      case "descendant":
        descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
        await new Promise((resolve) => descendant.stdout.once("data", resolve));
        emit({ type: "descendant", pid: descendant.pid });
        break;
      case "exit": process.exit(23);
      default: throw new Error(`Unknown fixture action: ${command.action}`);
    }
    response(command);
  } else if (command.type === "reorder") {
    if (!first) first = command;
    else { response(command, { order: 2 }); response(first, { order: 1 }); first = undefined; }
  } else response(command);
}

if (scenario === "descendant") {
  descendant = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  descendant.stdout.once("data", () => emit({ type: "descendant", pid: descendant.pid }));
}
if (scenario === "stalled") {
  process.on("SIGTERM", () => emit({ type: "term_ignored" }));
  setInterval(() => {}, 1000);
}

async function handle(command) {
  if (script) return supervised(command);
  if (command.type === "extension_ui_response") {
    emit({ type: "ui_reply", reply: command });
    if (command.id === "abort-dialog" && pendingAbort) {
      emit({ type: "agent_settled", aborted: true });
      response(pendingAbort);
    }
    return;
  }
  emit({ type: "command_seen", command: command.type });
  if (command.type === "exit") process.exit(23);
  if (command.type === "orphan") process.exit(0);
  if (command.type === "corrupt") {
    const payloads = {
      json: "not json\n",
      utf8: Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
      partial: "{\"type\":",
      large: `${"x".repeat(4096)}\n`,
      incomplete: "x".repeat(768),
      array: "[]\n",
      missingType: "{}\n",
      mismatch: JSON.stringify({ type: "response", id: command.id, command: "wrong", success: true }) + "\n",
      unknownId: JSON.stringify({ type: "response", id: "alien", command: "corrupt", success: true }) + "\n",
      parse: JSON.stringify({ type: "response", command: "parse", success: false, error: "parse failed" }) + "\n",
    };
    process.stdout.write(payloads[command.kind]);
    if (command.kind === "partial") process.stdout.end();
    return;
  }
  if (command.type === "stderr") {
    process.stderr.write("diagnostic ".repeat(1024), () => response(command));
    return;
  }
  if (command.type === "unsuccessful") {
    emit({ type: "response", id: command.id, command: command.type, success: false, error: "rejected" });
    return;
  }
  if (command.type === "never") return;
  if (command.type === "reorder") {
    if (!first) first = command;
    else {
      response(command, { order: 2 });
      response(first, { order: 1 });
      first = undefined;
    }
    return;
  }
  if (command.type === "split") {
    const data = Buffer.from(JSON.stringify({ type: "future_event", text: "a\u2028b\u2029c雪" }) + "\r\n");
    for (const byte of data) {
      process.stdout.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response(command);
    return;
  }
  if (command.type === "ui") {
    emit({ type: "extension_ui_request", id: "notice", method: "notify", message: "notice" });
    for (let i = 0; i < (command.count ?? 1); i++) {
      emit({ type: "extension_ui_request", id: `dialog-${i}`, method: "input", title: "Question" });
    }
    response(command);
    emit({ type: "queue_update", steering: ["guidance"], followUp: [] });
    emit({ type: "session_info_changed", name: "test" });
    return;
  }
  if (command.type === "prompt") {
    if (command.message === "handled" || command.message === "handled-settled") {
      if (command.message === "handled-settled") emit({ type: "agent_settled", aborted: false });
      response(command, { disposition: "handled" });
      return;
    }
    emit({ type: "agent_start" });
    if (command.message === "retry") {
      response(command, { disposition: "started" });
      emit({ type: "agent_end", messages: [], willRetry: true });
      emit({ type: "auto_retry_start", attempt: 1 });
      // A command from the test, rather than a timer, releases settlement.
      return;
    }
    emit({ type: "message_end", message: { role: "user", content: command.message } });
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled", aborted: false });
    response(command, { disposition: command.streamingBehavior ? "queued" : "started" });
    return;
  }
  if (command.type === "settle") {
    emit({ type: "auto_retry_end", success: true, attempt: 2 });
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled", aborted: false });
  }
  if (command.type === "clear_queue" && scenario === "stalled") return;
  if (command.type === "abort") {
    if (scenario === "dialog-on-abort") {
      pendingAbort = command;
      emit({ type: "extension_ui_request", id: "abort-dialog", method: "confirm", title: "Shutdown?" });
      return;
    }
    emit({ type: "agent_settled", aborted: true });
  }
  response(command);
}

process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    void handle(JSON.parse(line)).catch((error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exit(24);
    });
  }
});
process.stdin.on("end", () => {
  if (scenario !== "stalled") {
    emit({ type: "stdin_closed" });
    process.exit(0);
  }
});
