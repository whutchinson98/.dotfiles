import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { BuildController } from "../.pi/agent/extensions/planner-builder/build-controller.ts";
import { runBuilder, type BuilderTransport } from "../.pi/agent/extensions/planner-builder/builder-runner.ts";
import { createQuestionQueue } from "../.pi/agent/extensions/planner-builder/question-queue.ts";
import type { RpcAgentOptions, RpcCloseResult, RpcPromptResult, RpcRecord, RpcResponse, RpcSettlement } from "../.pi/agent/extensions/planner-builder/rpc-agent.ts";
import { parsePlanTaskResultMarker } from "../.pi/agent/extensions/planner-builder/result-marker.ts";
import { detectVcs, GitBackend } from "../.pi/agent/extensions/planner-builder/vcs.ts";

/** Run the real scheduler/jj helpers without Pi UI packages or actual agent subprocesses. */
export function loadPlannerBuilder(workspaceRoot: string): Record<string, any> {
  const source = fs.readFileSync(new URL("../.pi/agent/extensions/planner-builder/index.ts", import.meta.url), "utf8");
  const javascript = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export default function/gm, "function registerExtension");
  const mutations = new Map<string, Promise<unknown>>();
  const context = vm.createContext({
    spawn, fs, os, path, randomUUID, detectVcs, GitBackend, parsePlanTaskResultMarker,
    BuildController, runBuilder, createQuestionQueue,
    createUserQuestionBridge: () => { throw new Error("Inject a question bridge for this test"); },
    parseUserQuestion: () => { throw new Error("Inject a question parser for this test"); },
    writeUserQuestionResponse: () => { throw new Error("Inject a question writer for this test"); },
    process: { ...process, env: { ...process.env, PI_PLAN_WORKSPACE_ROOT: workspaceRoot } },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    Type: new Proxy({}, { get: () => () => ({}) }), StringEnum: () => ({}),
    truncateHead: (content: string) => ({ content, truncated: false }),
    truncateTail: (content: string) => ({ content, truncated: false }),
    formatSize: String, USER_QUESTION_TOOL_NAME: "ask_user",
    sendSystemNotification: () => {},
    discoverAgents: () => ({ agents: ["builder", "verifier", "planner"].map((name) => ({ name, source: "user", systemPrompt: "" })) }),
    withFileMutationQueue: (file: string, fn: () => Promise<unknown>) => {
      const next = (mutations.get(file) ?? Promise.resolve()).then(fn);
      mutations.set(file, next.catch(() => {}));
      return next;
    },
  });
  return vm.runInContext(`${javascript}\n({
    buildPlanFile, createBuilderTask, createVerifierTask, createPlannerTask,
    parsePlanTasks, selectParallelTaskBatch, classifyBuilderResult,
    getJjWorkspaceRoot, getMainJjWorkspaceRoot, getCommitId,
    createTaskWorkspace, validateTaskWorkspaceCommit, integrateTaskWorkspace,
    setRunAgent(fn) { runAgent = fn; },
    setBuilderLifecycle(fn) { runBuilderLifecycle = fn; },
    setBuilderTransport(fn) { builderDependencies.createTransport = fn; }
  })`, context);
}

/** Explicit RPC seam: runs scripted workspace work and emits authoritative lifecycle
 * records, including get_state and joined shutdown. Never masquerades as runAgent. */
export class ScriptedBuilderTransport implements BuilderTransport {
  readonly state = { accepting: true, isSettled: false, settledGeneration: 0, pendingRequests: 0,
    completionWaiters: 0, queuedWrites: 0, queuedWriteBytes: 0, pendingUi: 0 };
  failure?: Error;
  stderr = "";
  stopped = false;
  readonly closed: Promise<RpcCloseResult>;
  readonly options: RpcAgentOptions;
  private resolveClosed!: (result: RpcCloseResult) => void;
  private listeners = new Set<(record: RpcRecord) => void>();
  private waiters: Array<(settled: RpcSettlement | null) => void> = [];
  private readonly script: (transport: ScriptedBuilderTransport, prompt: string) => Promise<void>;
  private work = Promise.resolve();
  private nextMessage = 0;
  private sessionId: string;

  constructor(options: RpcAgentOptions, script: (transport: ScriptedBuilderTransport, prompt: string) => Promise<void>) {
    this.options = options;
    this.script = script;
    this.sessionId = randomUUID(); // Deliberately actual, not the requested CLI ID.
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }
  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(record: RpcRecord): void {
    if (record.type === "agent_start") this.state.isSettled = false;
    if (record.type === "agent_settled") { this.state.isSettled = true; this.state.settledGeneration++; }
    for (const listener of this.listeners) listener(record);
    if (record.type === "agent_settled") {
      for (const resolve of this.waiters.splice(0)) resolve({ generation: this.state.settledGeneration, observedAt: Date.now(), aborted: record.aborted === true });
    }
  }
  message(text = "PLAN_TASK_RESULT: done", stopReason = "stop", tokens = 10): void {
    const message = { role: "assistant", timestamp: ++this.nextMessage, content: [{ type: "text", text }],
      stopReason, usage: { input: tokens, output: tokens, totalTokens: tokens * 2, cost: { total: 0.01 } } };
    this.emit({ type: "message_start", message: { ...message, stopReason: "pending", content: [] } });
    this.emit({ type: "message_end", message });
  }
  settle(aborted = false): void {
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled", aborted });
  }
  async prompt(message: string): Promise<RpcPromptResult> {
    const settled = new Promise<RpcSettlement | null>((resolve) => { this.waiters.push(resolve); });
    this.emit({ type: "agent_start" });
    this.work = this.script(this, message).catch((error) => {
      this.failure = error;
      this.message(String(error), "error");
      this.settle();
    });
    return { disposition: "started", response: { type: "response", id: "prompt", command: "prompt", success: true, data: { disposition: "started" } }, settled };
  }
  async request(command: string): Promise<RpcResponse> {
    const args = this.options.invocation.args;
    const dir = args[args.indexOf("--session-dir") + 1];
    const data = { isStreaming: !this.state.isSettled, isCompacting: false, pendingMessageCount: 0,
      sessionId: this.sessionId, sessionFile: args.includes("--no-session") ? undefined : path.join(dir, `${this.sessionId}.jsonl`) };
    const response: RpcResponse = { type: "response", id: randomUUID(), command, success: true, data };
    this.emit(response);
    return response;
  }
  async stop(): Promise<RpcCloseResult> {
    if (this.stopped) return this.closed;
    this.stopped = true;
    this.state.accepting = false;
    await this.work;
    for (const resolve of this.waiters.splice(0)) resolve(null);
    const closed = { code: 0, signal: null, stderr: this.stderr, stderrTruncated: false, signals: [], shutdownErrors: [] };
    this.resolveClosed(closed);
    return closed;
  }
}

