import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const SUPERVISOR_TOOLS = ["inspect_build", "inspect_task", "steer_task", "request_user_decision"] as const;
export type SupervisorToolName = typeof SUPERVISOR_TOOLS[number];
export interface SupervisorLaunchIdentity {
  runId: string;
  launchId: string;
}
export interface SupervisorToolRequest {
  toolCallId: string;
  toolName: SupervisorToolName;
  args: Record<string, unknown>;
}
export interface SupervisorBridgeOptions {
  identity: SupervisorLaunchIdentity;
  /** The parent authorizes every action against this bound launch, not request.args.runId.
   * Dispatch must honor cancellation and settle after joining its owned work. */
  dispatch: (request: SupervisorToolRequest, identity: Readonly<SupervisorLaunchIdentity>, signal: AbortSignal) => Promise<unknown>;
  maxOutstanding?: number;
  maxRequests?: number;
  timeoutMs?: number;
}
export interface SupervisorBridge {
  dir: string;
  extensionPath: string;
  /** Call from the stdout observer without awaiting it there; surface rejections to the owner. */
  handleToolStart: (record: unknown) => Promise<boolean>;
  cancel: (toolCallId: string) => void;
  /** Stop/join the child before disposing. Cancels and joins parent dispatch before removing files. */
  dispose: () => Promise<void>;
}

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_ID_BYTES = 1024;

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid bridge limit");
  return value;
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id || Buffer.byteLength(JSON.stringify(id)) > MAX_ID_BYTES) {
    throw new Error("Invalid or oversized tool-call ID");
  }
}

/** JSON encoding preserves even lone UTF-16 surrogates; sanitizing IDs or hashing lossy UTF-8 does not. */
export function supervisorResponsePath(dir: string, toolCallId: string): string {
  validateId(toolCallId);
  const digest = createHash("sha256").update(JSON.stringify(toolCallId)).digest("hex");
  return path.join(dir, `${digest}.response.json`);
}

function extensionSource(dir: string, timeoutMs: number): string {
  return `import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@mariozechner/pi-ai";

const dir = ${JSON.stringify(dir)};
const maxResponseBytes = ${MAX_RESPONSE_BYTES};
const identity = {
  taskId: Type.String({ maxLength: 256 }),
  attemptId: Type.String({ maxLength: 256 }),
};
const evidence = Type.Object({
  kind: Type.Union([Type.Literal("file"), Type.Literal("diff")]),
  path: Type.String({ maxLength: 1024 }),
  startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
}, { additionalProperties: false });
const tools = [
  ["inspect_build", "Inspect bounded build state. Evidence is not integration validation.", Type.Object({}, { additionalProperties: false })],
  ["inspect_task", "Inspect a current task attempt, optionally requesting one bounded file or diff.", Type.Object({ ...identity, evidence: Type.Optional(evidence) }, { additionalProperties: false })],
  ["steer_task", "Propose guidance for a current attempt. The parent authorizes it; advisory proposals are not delivered and steering does not interrupt shell tools.", Type.Object({
    ...identity,
    guidance: Type.String({ maxLength: 4096 }),
    reason: Type.String({ maxLength: 2048 }),
    evidenceSequences: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 32 })),
  }, { additionalProperties: false })],
  ["request_user_decision", "Ask one material question through the parent's serialized, cancellable UI.", Type.Object({
    question: Type.String({ maxLength: 4096 }),
    options: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 8 })),
  }, { additionalProperties: false })],
];

async function waitForResponse(id, signal) {
  if (typeof id !== "string" || !id || Buffer.byteLength(JSON.stringify(id)) > ${MAX_ID_BYTES}) throw new Error("Invalid tool-call ID");
  const file = path.join(dir, createHash("sha256").update(JSON.stringify(id)).digest("hex") + ".response.json");
  const deadline = Date.now() + ${timeoutMs + 1000};
  while (!signal?.aborted && Date.now() < deadline) {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxResponseBytes) throw new Error("Invalid response file size or type");
      const buffer = Buffer.alloc(maxResponseBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > maxResponseBytes) throw new Error("Response size limit exceeded");
      const response = JSON.parse(buffer.subarray(0, total).toString("utf8"));
      if (typeof response?.ok !== "boolean") throw new Error("Invalid bridge response");
      return response;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      await handle?.close();
    }
    await delay(25, undefined, { signal }).catch((error) => { if (!signal?.aborted) throw error; });
  }
  throw new Error(signal?.aborted ? "Supervisor request cancelled" : "Supervisor response timeout");
}

export default function (pi) {
  for (const [name, description, parameters] of tools) {
    pi.registerTool({
      name, label: name, description, parameters, executionMode: "sequential",
      async execute(toolCallId, params, signal) {
        if (Buffer.byteLength(JSON.stringify(params)) > ${MAX_REQUEST_BYTES}) throw new Error("Request size limit exceeded");
        const response = await waitForResponse(toolCallId, signal);
        if (!response.ok) throw new Error(response.error || "Supervisor request failed");
        return { content: [{ type: "text", text: JSON.stringify(response.result) }], details: response.result };
      },
    });
  }
}
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodeResponse(response: unknown): string {
  try {
    const text = JSON.stringify(response);
    if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return text;
  } catch {
    // A dispatcher must return serializable, bounded data, never a partial JSON response.
  }
  return JSON.stringify({ ok: false, error: "Supervisor response serialization or size limit exceeded" });
}

export async function createSupervisorBridge(options: SupervisorBridgeOptions): Promise<SupervisorBridge> {
  const identity = Object.freeze({ ...options.identity });
  const maxOutstanding = boundedOption(options.maxOutstanding, 8, 32);
  const maxRequests = boundedOption(options.maxRequests, 512, 2048);
  const timeoutMs = boundedOption(options.timeoutMs, 300_000, 300_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-"));
  const extensionPath = path.join(dir, "supervisor-bridge.ts");
  try {
    await fs.chmod(dir, 0o700);
    await fs.writeFile(extensionPath, extensionSource(dir, timeoutMs), { mode: 0o600, flag: "wx" });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  const seen = new Set<string>();
  const pending = new Map<string, { controller: AbortController; done: Promise<boolean> }>();
  let closed = false;
  let disposal: Promise<void> | undefined;

  async function publish(id: string, response: unknown): Promise<void> {
    const destination = supervisorResponsePath(dir, id);
    const temporary = path.join(dir, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, encodeResponse(response), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async function handleToolStart(record: unknown): Promise<boolean> {
    if (closed || !isRecord(record) || record.type !== "tool_execution_start") return false;
    if (!SUPERVISOR_TOOLS.includes(record.toolName as SupervisorToolName)) return false;
    validateId(record.toolCallId);
    const id = record.toolCallId;
    if (seen.has(id)) return pending.get(id)?.done ?? true;
    if (!isRecord(record.args)) throw new Error("Supervisor arguments must be an object");
    const argsText = JSON.stringify(record.args);
    if (Buffer.byteLength(argsText) > MAX_REQUEST_BYTES) throw new Error("Supervisor request size limit exceeded");
    if (seen.size >= maxRequests) throw new Error("Supervisor bridge request limit exceeded");
    if (pending.size >= maxOutstanding) throw new Error("Supervisor bridge outstanding limit exceeded");
    const request: SupervisorToolRequest = { toolCallId: id, toolName: record.toolName as SupervisorToolName, args: JSON.parse(argsText) };
    const controller = new AbortController();
    seen.add(id);
    const timer = setTimeout(() => controller.abort(new Error("Supervisor request timeout")), timeoutMs);
    // Defer dispatch until it is registered, even when a parent callback completes synchronously.
    const done = Promise.resolve().then(async () => {
      let response: unknown;
      try {
        controller.signal.throwIfAborted();
        const result = await options.dispatch(request, identity, controller.signal);
        controller.signal.throwIfAborted();
        response = { ok: true, result: result ?? null };
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        response = { ok: false, error: reason instanceof Error ? reason.message : "Supervisor dispatch failed" };
      }
      if (!closed) await publish(id, response);
      return true;
    }).finally(() => {
      clearTimeout(timer);
      pending.delete(id);
    });
    pending.set(id, { controller, done });
    return done;
  }

  function cancel(toolCallId: string): void {
    pending.get(toolCallId)?.controller.abort(new Error("Supervisor request cancelled"));
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    closed = true;
    for (const { controller } of pending.values()) controller.abort(new Error("Supervisor bridge closed"));
    disposal = Promise.allSettled([...pending.values()].map(({ done }) => done)).then(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    return disposal;
  }

  return { dir, extensionPath, handleToolStart, cancel, dispose };
}
