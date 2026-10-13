import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentConfig } from "../subagent/agents.ts";
import type { UserQuestionBridge, UserQuestionRequest, UserQuestionResponse } from "../subagent/user-question.ts";
import type { BuildController, ControllerTransport } from "./build-controller.ts";
import { boundedText, type AttemptIdentity, type BuildObservation, type SessionMapping } from "./build-state.ts";
import { handleRpcQuestion, type QuestionQueue } from "./question-queue.ts";
import { RpcAgent, type RpcAgentOptions, type RpcClock, type RpcRecord } from "./rpc-agent.ts";
import type { TaskWorkspace, VcsKind } from "./vcs.ts";

export interface BuilderMonitorConfig {
  enabled: boolean;
  intervalSeconds: number;
  stuckTimeoutSeconds: number;
  maxRestarts: number;
}
export interface BuilderUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; contextTokens: number; turns: number;
}
export interface BuilderAttemptSummary {
  attempt: number;
  attemptId?: string;
  session?: SessionMapping;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  lastProgress?: string;
  usage: BuilderUsage;
  controls: Array<{ controlId: string; status: string; reason: string }>;
}
export interface BuilderResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  cwd: string;
  exitCode: number;
  finalOutput: string;
  liveOutput?: string;
  stderr: string;
  usage: BuilderUsage;
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  stopReason?: string;
  errorMessage?: string;
  progressMessage?: string;
  restartCount: number;
  attempts: BuilderAttemptSummary[];
}
export type BuilderTransport = ControllerTransport & Pick<RpcAgent, "stderr">;
export interface BuilderDependencies {
  getInvocation: (args: string[]) => { command: string; args: string[] };
  writeSystemPrompt: (agent: string, prompt: string) => Promise<{ dir: string; filePath: string }>;
  writeMaxEffortExtension: () => Promise<{ dir: string; filePath: string }>;
  createQuestionBridge: () => Promise<UserQuestionBridge>;
  parseQuestion: (id: string, args: unknown, agent: string) => UserQuestionRequest;
  writeQuestionResponse: (dir: string, id: string, response: UserQuestionResponse) => Promise<void>;
  createTransport?: (options: RpcAgentOptions) => BuilderTransport;
  inspectResume?: typeof inspectBuilderResume;
  clock?: RpcClock;
}
export interface RunBuilderOptions {
  workspace: TaskWorkspace;
  vcs: VcsKind;
  sourceRoot: string;
  protectedPaths: readonly string[];
  taskId: string;
  task: string;
  agent: AgentConfig;
  model?: string;
  effort?: BuilderResult["effort"];
  monitor: BuilderMonitorConfig;
  controller: BuildController;
  questions: QuestionQueue;
  /** Required only for supervised attempts. Owned by the build, outside all checkouts. */
  runDirectory?: string;
  checkpoint?: (identity: AttemptIdentity, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onOutput?: (result: BuilderResult) => void;
  dependencies: BuilderDependencies;
}

const CLOCK: RpcClock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const exec = promisify(execFile);
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function emptyUsage(): BuilderUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
function sumUsage(previous: BuilderUsage, current: BuilderUsage): BuilderUsage {
  return {
    input: previous.input + current.input, output: previous.output + current.output,
    cacheRead: previous.cacheRead + current.cacheRead, cacheWrite: previous.cacheWrite + current.cacheWrite,
    cost: previous.cost + current.cost, turns: previous.turns + current.turns, contextTokens: current.contextTokens,
  };
}
function preview(text: string, bytes: number): string {
  const bounded = boundedText(text, bytes);
  return bounded.text + (bounded.truncated ? "\n[truncated]" : "");
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Read retained work only after the previous child has joined. This is an inventory,
 * not integration validation; no history repair or workspace management is performed. */
export async function inspectBuilderResume(workspace: TaskWorkspace, vcs: VcsKind): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/.test(workspace.baseRevision)) throw new Error("Invalid builder base revision");
  async function command(args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
    for (const key of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(key)) delete env[key];
    }
    return (await exec(vcs, args, { cwd: workspace.rootPath, env, timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim();
  }
  const base = workspace.baseRevision;
  let status: string;
  let history: string;
  let commit: string | undefined;
  if (vcs === "git") {
    status = await command(["status", "--short", "--untracked-files=all"]);
    const head = await command(["rev-parse", "HEAD"]);
    history = await command(["log", "--format=%H %P", "--max-count=3", `${base}..HEAD`]);
    const lines = history.split("\n").filter(Boolean);
    if (head !== base) {
      const [id, ...parents] = (lines[0] ?? "").split(" ");
      if (lines.length !== 1 || id !== head || parents.length !== 1 || parents[0] !== base) {
        throw new Error("Ambiguous retained Git history: expected at most one task commit directly on the supplied base");
      }
      commit = id;
    } else if (lines.length) throw new Error("Ambiguous retained Git history");
  } else {
    // Snapshot retained edits before reading history; never update-stale or change revisions.
    status = await command(["--no-pager", "status"]);
    history = await command(["--no-pager", "--ignore-working-copy", "log", "--no-graph", "-r", `${base}..@`, "-T",
      'commit_id ++ " " ++ parents.map(|p| p.commit_id()).join(",") ++ " " ++ conflict ++ "\\n"']);
    const head = await command(["--no-pager", "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"]);
    const entries = history.split("\n").filter(Boolean).map((line) => line.split(" "));
    const working = entries.find(([id]) => id === head);
    const task = entries.find(([id]) => id !== head);
    if (!working || entries.length > 2 || entries.some((entry) => entry.length !== 3 || entry[2] !== "false") ||
        working[1] !== (task?.[0] ?? base) || (task && task[1] !== base)) {
      throw new Error("Ambiguous retained jj history: expected one working-copy commit and at most one task commit on the supplied base");
    }
    commit = task?.[0];
  }
  return [
    `Retained ${vcs} workspace: ${workspace.rootPath}`, `Supplied base: ${base}`,
    commit ? `Existing task commit: ${commit}. Inspect and reuse it; amend ONLY this task commit if necessary. Never create a second task commit.`
      : "No separate task commit exists. Retained dirty work may be prior attempt work; inspect ownership before continuing.",
    "Never amend the supplied base. Block if ownership or history is ambiguous.",
    `Status:\n${preview(status || "(clean)", 6 * 1024)}`, `History (commit parents):\n${preview(history, 2048)}`,
  ].join("\n");
}

async function sessionArguments(options: RunBuilderOptions): Promise<{ args: string[]; directory?: string }> {
  if (options.controller.config.supervisionMode === "off") return { args: ["--no-session"] };
  if (!options.runDirectory) throw new Error("Supervised builders require an external run directory");
  const directory = await fs.realpath(options.runDirectory);
  for (const root of [options.sourceRoot, options.workspace.rootPath]) {
    if (inside(await fs.realpath(root), directory)) throw new Error("Builder sessions must be outside source and task checkouts");
  }
  for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
    for (const marker of [".jj", ".git"]) {
      const exists = await fs.lstat(path.join(ancestor, marker)).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) throw new Error("Builder sessions must be outside checkouts");
    }
    if (path.basename(path.dirname(ancestor)) === ".pi" && ["plans", "outputs"].includes(path.basename(ancestor))) {
      throw new Error("Builder sessions must be outside protected plan/report paths");
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  const sessionId = randomUUID();
  const sessionDir = path.join(directory, `builder-${sessionId}`);
  await fs.mkdir(sessionDir, { mode: 0o700 });
  return { args: ["--session-id", sessionId, "--session-dir", sessionDir], directory: sessionDir };
}

function progress(observation: BuildObservation, agent: string): string | undefined {
  const payload = observation.payload;
  switch (payload.kind) {
    case "agent": return `${agent} ${payload.stage === "settled" ? "settled; checking completion" : payload.stage}...`;
    case "text": return `${agent} is writing...`;
    case "activity": return `${agent} is ${payload.channel === "thinking" ? "thinking" : "working"}...`;
    case "tool": {
      if (payload.stage === "end") return `${agent} ${payload.isError ? "failed" : "finished"} ${payload.toolName}.`;
      const input = payload.stage === "start" ? ` ${preview(payload.input.text, 160)}` : "";
      return `${agent} is running ${payload.toolName}${input}...`;
    }
    case "retry": return `${agent} ${payload.active ? "retrying" : "finished retry"}: ${preview(payload.error.text, 160)}`;
    case "compaction": return `${agent} ${payload.active ? "is compacting context" : "finished compaction"}...`;
    case "human-wait": return `${agent} ${payload.waiting ? "is waiting for user input" : "resumed after user input"}.`;
    case "message": return payload.stage === "end" ? `${agent} output received.` : undefined;
    default: return undefined;
  }
}

/** Builder-only lifecycle. Planner/verifier/generic subagents remain one-shot. */
export async function runBuilder(options: RunBuilderOptions): Promise<BuilderResult> {
  const { agent, workspace, controller, dependencies, monitor } = options;
  const clock = dependencies.clock ?? CLOCK;
  const attempts: BuilderAttemptSummary[] = [];
  let total = emptyUsage();
  let stderr = "";
  let prompt = options.task;
  const maximum = monitor.enabled ? monitor.maxRestarts + 1 : 1;

  for (let attempt = 1; attempt <= maximum; attempt++) {
    const result: BuilderResult = {
      agent: agent.name, agentSource: agent.source ?? "unknown", task: options.task, cwd: workspace.cwd,
      model: options.model?.trim() || agent.model, effort: options.effort, exitCode: 0,
      finalOutput: "", stderr, usage: total, restartCount: attempt - 1, attempts: [...attempts],
    };
    if (attempt > 1) {
      try {
        const inventory = await (dependencies.inspectResume ?? inspectBuilderResume)(workspace, options.vcs);
        prompt = `${options.task}\n\nRestart inventory (parent-observed after prior child shutdown):\n${inventory}\n\nPrior attempt/control summary:\n${preview(JSON.stringify(attempts), 8 * 1024)}\nThis is a fresh conversation, not a resumed session. Inspect retained files and history; do not repeat a completed commit.`;
      } catch (error) {
        return { ...result, finalOutput: `Restart blocked: ${errorText(error)}\nPLAN_TASK_RESULT: blocked`, stopReason: "blocked", errorMessage: errorText(error) };
      }
    }
    let transport: BuilderTransport | undefined;
    let identity: AttemptIdentity | undefined;
    let registered!: (identity: AttemptIdentity | undefined) => void;
    const registration = new Promise<AttemptIdentity | undefined>((resolve) => { registered = resolve; });
    let bridge: UserQuestionBridge | undefined;
    const temporary: string[] = [];
    const questionAbort = new AbortController();
    const questionWork = new Set<Promise<void>>();
    const questionIds = new Set<string>();
    const waits = new Set<string>();
    let unsubscribe = (): void => {};
    let unsubscribeRecords = (): void => {};
    let timer: unknown;
    let timedOut = false;
    let sealed = false;
    let lastActivityAt = clock.now();
    let lastOutputAt = -Infinity;
    let lastStderr = "";
    let lastWatchdogAt = clock.now();
    let attemptUsage = emptyUsage();
    let failure: string | undefined;
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => { interrupt = resolve; });

    function emit(force = false): void {
      if (!force && clock.now() - lastOutputAt < 500) return;
      lastOutputAt = clock.now();
      result.stderr = (stderr + (transport?.stderr ?? "")).slice(-20_000);
      result.usage = sumUsage(total, attemptUsage);
      options.onOutput?.({ ...result, usage: { ...result.usage }, attempts: [...attempts] });
    }
    function abort(): void { questionAbort.abort(); interrupt(); }
    function beginWait(id: string): string {
      const key = createHash("sha256").update(id).digest("hex");
      if (identity && !waits.has(key)) {
        waits.add(key);
        controller.beginHumanWait(identity, key);
      }
      return key;
    }
    function endWait(key: string): void {
      if (identity && waits.delete(key)) controller.endHumanWait(identity, key);
      lastActivityAt = clock.now();
    }
    function tick(): void {
      const diagnostic = transport?.stderr ?? "";
      if (diagnostic !== lastStderr) {
        lastStderr = diagnostic;
        const line = diagnostic.trim().split("\n").pop();
        if (line) result.progressMessage = `${agent.name} stderr: ${preview(line, 160)}`;
      }
      emit(); // Diagnostics never count as structured task progress.
      if (identity && monitor.enabled && clock.now() - lastWatchdogAt >= monitor.intervalSeconds * 1000) {
        lastWatchdogAt = clock.now();
        if (!controller.watchdogState(identity).paused && clock.now() - lastActivityAt >= monitor.stuckTimeoutSeconds * 1000) {
          timedOut = true;
          abort();
          return;
        }
      }
      timer = clock.setTimeout(tick, Math.min(500, monitor.intervalSeconds * 1000));
    }
    async function askTool(record: RpcRecord): Promise<void> {
      const id = record.toolCallId as string;
      const key = beginWait(`tool:${id}`);
      try {
        const question = dependencies.parseQuestion(id, record.args, agent.name);
        const answer = await options.questions.ask({
          owner: identity!.attemptId, id: key, method: "input", title: question.question,
          message: question.options.map((option) => `${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n") || undefined,
        }, questionAbort.signal);
        let response: UserQuestionResponse;
        if (answer.status === "answered") response = { status: "answered", answer: String(answer.value) };
        else {
          const status = answer.status === "timeout" ? "cancelled" : answer.status;
          response = { status, message: answer.message };
        }
        await dependencies.writeQuestionResponse(bridge!.dir, id, response);
      } finally { endWait(key); }
    }
    async function cancellable<T>(work: Promise<T>): Promise<T> {
      return Promise.race([work, interrupted.then(() => { throw new Error(failure ?? "Builder attempt aborted"); })]);
    }

    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      const session = await sessionArguments(options);
      const args = ["--mode", "rpc", ...session.args];
      if (!agent.includeExtensions) args.push("--no-extensions");
      if (result.model) args.push("--model", result.model);
      if (options.effort) args.push("--thinking", options.effort === "max" ? "xhigh" : options.effort);
      if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
      if (agent.tools?.includes("ask_user")) {
        bridge = await dependencies.createQuestionBridge();
        temporary.push(bridge.dir);
        args.push("--extension", bridge.extensionPath);
      }
      if (options.effort === "max") {
        const extension = await dependencies.writeMaxEffortExtension();
        temporary.push(extension.dir);
        args.push("--extension", extension.filePath);
      }
      if (agent.systemPrompt.trim()) {
        const system = await dependencies.writeSystemPrompt(agent.name, agent.systemPrompt);
        temporary.push(system.dir);
        args.push("--append-system-prompt", system.filePath);
      }
      transport = (dependencies.createTransport ?? ((rpc) => new RpcAgent(rpc)))({
        invocation: dependencies.getInvocation(args), cwd: workspace.cwd,
        env: { ...process.env, PI_SUBAGENT: "1", PI_SUBAGENT_NAME: agent.name,
          ...(bridge ? { PI_USER_QUESTION_BRIDGE_DIR: bridge.dir } : {}) },
        // Waiting for a human is governed by the shared queue, not RPC's shorter defaults.
        limits: { completionTimeoutMs: 2_147_483_647 },
        uiHandler: async (request, signal) => {
          // Startup extensions can ask while attempt registration is being journaled.
          const owner = identity ?? await registration;
          if (!owner || signal.aborted) return { cancelled: true };
          const key = beginWait(`rpc:${request.id}`);
          try {
            const reply = await handleRpcQuestion(options.questions, owner.attemptId, request, signal);
            if (reply?.cancelled) return { cancelled: true };
            if (reply?.confirmed !== undefined) return { confirmed: reply.confirmed };
            if (reply?.value !== undefined) return { value: reply.value };
          } finally { endWait(key); }
        },
      });
      identity = await controller.registerAttempt({
        taskId: options.taskId, attemptNumber: attempt, transport,
        workspace: { rootPath: workspace.rootPath, baseRevision: workspace.baseRevision, vcs: options.vcs, protectedPaths: options.protectedPaths },
      });
      registered(identity);
      lastActivityAt = clock.now();
      unsubscribe = controller.onObservation((observation) => {
        if (observation.attemptId !== identity!.attemptId || !observation.applied) return;
        if (observation.meaningful || (observation.payload.kind === "human-wait" && !observation.payload.waiting)) lastActivityAt = clock.now();
        const snapshot = controller.inspectTask(identity!);
        attemptUsage = { ...attemptUsage, input: snapshot.usage.input, output: snapshot.usage.output,
          cacheRead: snapshot.usage.cacheRead, cacheWrite: snapshot.usage.cacheWrite, cost: snapshot.usage.cost };
        if (observation.meaningful && observation.payload.kind === "message" && observation.payload.stage === "end" && observation.payload.message.role === "assistant") {
          attemptUsage.turns++;
          attemptUsage.contextTokens = observation.payload.message.usage.totalTokens;
        }
        result.liveOutput = snapshot.assistantText.text;
        result.progressMessage = progress(observation, agent.name) ?? result.progressMessage;
        emit(observation.payload.kind !== "text" && observation.payload.kind !== "activity");
      });
      unsubscribeRecords = transport.onRecord((record) => {
        if (record.type === "message_end" && object(record.message).role === "assistant") {
          const message = object(record.message);
          const content = Array.isArray(message.content) ? message.content : [];
          // Keep a bounded tail for result markers; observation snapshots intentionally keep a prefix.
          result.finalOutput = content.filter((block) => object(block).type === "text").map((block) => object(block).text).join("\n").slice(-64 * 1024);
        }
        if (record.type !== "tool_execution_start" || record.toolName !== "ask_user" || !bridge || typeof record.toolCallId !== "string") return;
        const safeId = record.toolCallId.replace(/[^A-Za-z0-9_.-]+/g, "_");
        if (questionIds.has(safeId) || questionIds.size >= 1024 || questionWork.size >= 32) {
          failure = "Duplicate or excessive builder question bridge request";
          abort();
          return;
        }
        questionIds.add(safeId);
        const work = askTool(record).catch((error) => { failure = `Question bridge failed: ${errorText(error)}`; abort(); });
        questionWork.add(work);
        void work.finally(() => questionWork.delete(work));
      });
      timer = clock.setTimeout(tick, Math.min(500, monitor.intervalSeconds * 1000));
      // RPC emits no session header. The controller records the actual get_state mapping.
      const state = object((await cancellable(transport.request("get_state"))).data);
      if (typeof state.sessionId !== "string" || !state.sessionId) throw new Error("Builder get_state omitted its actual session identity");
      if (session.directory && (typeof state.sessionFile !== "string" || !path.isAbsolute(state.sessionFile) || !inside(session.directory, state.sessionFile))) {
        throw new Error("Builder get_state did not confirm the requested external session directory");
      }
      const receipt = await cancellable(transport.prompt(`Task: ${prompt}`).then((receipt) => {
        // A cancellation can win before the command receipt. Always consume its
        // completion promise, even when this attempt will no longer await it.
        void receipt.settled.catch(() => {});
        return receipt;
      }));
      if (receipt.disposition === "handled") throw new Error("Builder prompt was handled without starting a task run");
      await cancellable(receipt.settled);
      await cancellable(Promise.all([...questionWork]));
      await cancellable(controller.sealAttemptForIntegration(identity, {
        checkpoint: options.checkpoint ? (signal) => options.checkpoint!(identity!, signal) : undefined,
      }));
      sealed = true;
    } catch (error) {
      result.exitCode = 1;
      result.errorMessage = errorText(error);
    } finally {
      registered(undefined);
      clock.clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      questionAbort.abort();
      if (identity) {
        options.questions.cancelOwner(identity.attemptId);
        for (const key of waits) endWait(key);
        if (!sealed) await controller.cancelTask(identity);
      }
      if (transport) {
        const closed = await transport.stop();
        stderr = (stderr + closed.stderr).slice(-20_000);
        if (closed.error || closed.shutdownErrors.length) {
          result.exitCode = 1;
          result.errorMessage = closed.error?.message ?? closed.shutdownErrors.join("; ");
          failure = result.errorMessage; // Never restart when owned-process cleanup is uncertain.
        }
      }
      await Promise.all([...questionWork]);
      unsubscribe();
      unsubscribeRecords();
      await Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
    const snapshot = identity ? controller.inspectTask(identity) : undefined;
    result.stopReason = snapshot?.outcome ?? (sealed ? "stop" : "error");
    if (options.signal?.aborted) result.stopReason = "aborted";
    if (timedOut) {
      result.exitCode = 124;
      result.stopReason = "stuck";
      result.errorMessage = failure ?? snapshot?.controllerError ?? `No structured task progress for ${monitor.stuckTimeoutSeconds} seconds (human waits excluded).`;
    }
    total = sumUsage(total, attemptUsage);
    result.usage = total;
    result.stderr = stderr;
    result.progressMessage = result.errorMessage ?? result.progressMessage;
    attempts.push({ attempt, attemptId: identity?.attemptId, session: snapshot?.session,
      exitCode: result.exitCode, stopReason: result.stopReason, errorMessage: result.errorMessage,
      lastProgress: result.progressMessage, usage: attemptUsage,
      controls: snapshot?.controlOutcomes.map(({ controlId, status, reason }) => ({ controlId, status, reason })) ?? [],
    });
    result.attempts = [...attempts];
    options.onOutput?.(result);
    if (timedOut && !failure && !snapshot?.controllerError && attempt < maximum && !options.signal?.aborted) continue;
    return result;
  }
  throw new Error("Builder restart loop exited without a result");
}
