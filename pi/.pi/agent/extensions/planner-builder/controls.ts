import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildController } from "./build-controller.ts";
import { boundedText, type SupervisionMode } from "./build-state.ts";

export interface BuildCommand {
  path?: string;
  taskIds: string[];
  runVerifier: boolean;
  supervisionMode: SupervisionMode;
}
export function parseBuildCommand(args: string): BuildCommand {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    if (!token.startsWith("-")) { positional.push(token); continue; }
    if (!["--verify", "--supervise", "--advisory"].includes(token)) throw new Error(`Unknown /plan-build flag: ${token}`);
    if (flags.has(token)) throw new Error(`Duplicate /plan-build flag: ${token}`);
    flags.add(token);
  }
  if (flags.has("--supervise") && flags.has("--advisory")) throw new Error("Choose --supervise OR --advisory, not both.");
  const planPath = positional[0] && !/^T\d+(?:[,\s]|$)/i.test(positional[0]) ? positional.shift() : undefined;
  const taskIds = positional.join(",").split(/[,\s]+/).filter(Boolean);
  if (taskIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))) throw new Error("Usage: /plan-build [--verify] [--supervise|--advisory] [plan-file] [T01,T02]");
  let supervisionMode: SupervisionMode = "off";
  if (flags.has("--supervise")) supervisionMode = "steer";
  if (flags.has("--advisory")) supervisionMode = "advisory";
  return { path: planPath, taskIds, runVerifier: flags.has("--verify"), supervisionMode };
}

export interface OwnedOperation {
  readonly runId: string;
  readonly kind: "create" | "build";
  readonly abort: AbortController;
  readonly completion: Promise<unknown>;
  controller?: BuildController;
  runDirectory?: string;
  journalPath?: string;
}

/** One runtime owner, acquired synchronously before any command startup/idle wait. */
export class PlannerOperations {
  active?: OwnedOperation;
  private closing = false;

  run<T>(kind: OwnedOperation["kind"], work: (operation: OwnedOperation) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing) throw new Error("Planner-builder runtime is shutting down.");
    if (this.active) throw new Error(`Planner-builder already owns ${this.active.kind} run ${this.active.runId}. Use /plan-inspect or /plan-cancel.`);
    const abort = new AbortController();
    const forward = (): void => { abort.abort(); };
    signal?.addEventListener("abort", forward, { once: true });
    if (signal?.aborted) forward();
    // Work starts in a microtask: active and completion are installed before it runs.
    const completion = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return work(operation);
    }).finally(() => {
      signal?.removeEventListener("abort", forward);
      if (this.active === operation) this.active = undefined;
    });
    const operation: OwnedOperation = { runId: randomUUID(), kind, abort, completion };
    this.active = operation;
    return completion;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const operation = this.active;
    if (!operation) return;
    operation.abort.abort();
    // Do not release ownership until the work's finally has joined children and persistence.
    await Promise.allSettled([operation.controller?.cancelBuild(), operation.completion]);
  }

  async control(command: "inspect" | "steer" | "cancel", args: string): Promise<string> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    if ((command === "inspect" && tokens.length > 2) ||
        (command === "steer" && tokens.length < 4) ||
        (command === "cancel" && tokens.length !== 1 && tokens.length !== 3)) {
      const usage = {
        inspect: "Usage: /plan-inspect [runId] [taskId]",
        steer: "Usage: /plan-steer <runId> <taskId> <attemptId> <guidance>",
        cancel: "Usage: /plan-cancel <runId> [taskId attemptId]",
      };
      throw new Error(usage[command]);
    }
    const operation = this.active;
    if (!operation || (tokens[0] && tokens[0] !== operation.runId)) throw new Error("No matching active run; stale controls cannot target another run. Historical sessions/journals are inspection-only.");
    const controller = operation.controller;
    if (command === "cancel" && tokens.length === 1) {
      operation.abort.abort();
      await controller?.cancelBuild();
      return `Run ${operation.runId}: cancellation accepted; cleanup is joining owned processes. Inspect status until ownership is released.`;
    }
    if (!controller) {
      if (command !== "inspect" || tokens.length > 1) throw new Error("Run has no active builder controller yet.");
      return `Run ${operation.runId}: ${operation.kind} starting or awaiting parent idle.`;
    }
    const build = controller.inspectBuild();
    const taskId = tokens[1]?.toUpperCase();
    const task = taskId ? build.tasks.find((item) => item.taskId === taskId) : undefined;
    if (taskId && !task) throw new Error(`No current attempt for task ${taskId}.`);
    if (command === "inspect") {
      const value = task ? controller.inspectTask(task) : { ...build, runDirectory: operation.runDirectory, journalPath: operation.journalPath };
      const preview = boundedText(JSON.stringify(value, null, 2), 32 * 1024);
      return preview.text + (preview.truncated ? "\n[Inspection truncated; inspect a specific task]" : "");
    }
    const identity = { runId: tokens[0], taskId: taskId!, attemptId: tokens[2] };
    if (command === "cancel") {
      if (!controller.inspectTask(identity).admissionOpen) throw new Error("Attempt control window is closed; cancellation cannot undo integration.");
      await controller.cancelTask(identity);
      return `Run ${identity.runId}, task ${identity.taskId}, attempt ${identity.attemptId}: cancelled; child joined.`;
    }
    const guidance = args.trim().replace(/^\S+\s+\S+\s+\S+\s+/, "");
    const receipt = await controller.requestGuidance({ ...identity, origin: "manual", guidance, reason: "Explicit manual guidance" });
    return JSON.stringify(receipt, null, 2);
  }
}

/** Cancel a command's idle wait without making runtime shutdown wait on the parent turn. */
export async function waitForParentIdle(wait: () => Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancel!: () => void;
  try {
    await Promise.race([wait(), new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("Planner-builder operation cancelled while waiting for parent idle."));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
  signal.throwIfAborted();
}

/** Resolve existing symlink ancestors even when the configured directory does not exist yet. */
export async function canonicalRunRoot(raw = path.join(os.homedir(), ".pi", "plan-runs")): Promise<string> {
  const expanded = raw === "~" ? os.homedir() : raw.replace(/^~\//, `${os.homedir()}/`);
  const absolute = path.resolve(expanded);
  async function canonical(candidate: string): Promise<string> {
    try { return await fs.realpath(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(candidate) === candidate) throw error;
      return path.join(await canonical(path.dirname(candidate)), path.basename(candidate));
    }
  }
  return canonical(absolute);
}

export interface PlanningQuestion { question: string; status: string; answer?: string }
const DECISIONS_HEADING = "## Planner question records (runner-authored)";
export function planningQuestionSection(questions: PlanningQuestion[]): string {
  // Encode before measuring: escaping user backticks can expand the stored bytes.
  function encode(value: unknown): string { return JSON.stringify(value).replace(/`/g, "\\u0060"); }
  const records: unknown[] = [];
  for (const question of questions.slice(0, 32)) {
    const record = { question: boundedText(question.question, 2048), status: question.status,
      answer: question.answer === undefined ? undefined : boundedText(question.answer, 4096) };
    if (Buffer.byteLength(encode([...records, record])) > 15 * 1024) break;
    records.push(record);
  }
  // Encode backticks too: user text must not close the runner's fenced section.
  const json = encode({ version: 1, records, omitted: questions.length - records.length });
  return `\n${DECISIONS_HEADING}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}
export function recordedPlanningQuestions(plan: string): string {
  const start = plan.lastIndexOf(`\n${DECISIONS_HEADING}\n`);
  return start < 0 ? "No runner-recorded questions (older plan); use the plan's documented decisions and guidance."
    : boundedText(plan.slice(start).split(/\n## (?!Planner question records)/)[0], 16 * 1024).text;
}
