import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
const scenario = process.argv[2] ?? "normal";
let buffer = "";
let first;
let descendant;
let pendingAbort;

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function response(command, data) {
  emit({ type: "response", id: command.id, command: command.type, success: true, data });
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
    void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (scenario !== "stalled") {
    emit({ type: "stdin_closed" });
    process.exit(0);
  }
});
