import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";

// Local, Node-only transport for Pi 1.2.0's documented RPC protocol. Invocation
// construction, session policy, event reduction and control authorization belong
// to the caller, not this module.
export type RpcRecord = { type: string; [key: string]: unknown };
export interface RpcResponse extends RpcRecord {
  type: "response";
  id: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
export interface RpcUiRequest extends RpcRecord {
  type: "extension_ui_request";
  id: string;
  method: string;
}
export type RpcUiReply = { cancelled: true } | { value: string } | { confirmed: boolean };
export interface RpcSettlement {
  generation: number;
  observedAt: number;
  aborted: boolean;
}
export type RpcPromptDisposition = "started" | "queued" | "handled";
export interface RpcPromptResult {
  disposition: RpcPromptDisposition;
  response: RpcResponse;
  // A settlement observation, not an integration barrier: later work can start.
  // Handled prompts resolve to null because they need not start any run.
  settled: Promise<RpcSettlement | null>;
}
export interface RpcPromptOptions {
  streamingBehavior?: "steer" | "followUp";
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  timeoutMs?: number;
  completionTimeoutMs?: number;
}
export interface RpcClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export type RpcSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;
export interface RpcLimits {
  recordBytes: number;
  incompleteBytes: number;
  stderrBytes: number;
  pendingRequests: number;
  completionWaiters: number;
  queuedWrites: number;
  queuedWriteBytes: number;
  uiRequests: number;
  requestTimeoutMs: number;
  completionTimeoutMs: number;
  uiTimeoutMs: number;
}
export interface RpcShutdownOptions {
  commandMs: number;
  gracefulMs: number;
  termMs: number;
  killMs: number;
}
export interface RpcAgentOptions {
  invocation: { command: string; args: string[] };
  cwd: string;
  env: NodeJS.ProcessEnv;
  limits?: Partial<RpcLimits>;
  shutdown?: Partial<RpcShutdownOptions>;
  dependencies?: {
    spawn?: RpcSpawn;
    clock?: RpcClock;
    platform?: NodeJS.Platform;
    signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  };
  // Serialized, bounded and never awaited by stdout. Handlers must honor abort;
  // an uncooperative promise cannot block draining or shutdown (nor start more UI).
  uiHandler?: (request: RpcUiRequest, signal: AbortSignal) => Promise<RpcUiReply | undefined> | RpcUiReply | undefined;
}
export interface RpcCloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr: string;
  stderrTruncated: boolean;
  signals: Array<"SIGTERM" | "SIGKILL">;
  shutdownErrors: string[];
}

export class RpcCommandError extends Error {
  readonly response: RpcResponse;
  constructor(response: RpcResponse) {
    super(`RPC ${response.command} failed: ${response.error}`);
    this.name = "RpcCommandError";
    this.response = response;
  }
}

const DEFAULT_LIMITS: RpcLimits = {
  recordBytes: 1024 * 1024,
  incompleteBytes: 1024 * 1024,
  stderrBytes: 64 * 1024,
  pendingRequests: 64,
  completionWaiters: 64,
  queuedWrites: 64,
  queuedWriteBytes: 2 * 1024 * 1024,
  uiRequests: 16,
  requestTimeoutMs: 30_000,
  completionTimeoutMs: 30 * 60_000,
  uiTimeoutMs: 300_000,
};
const DEFAULT_SHUTDOWN: RpcShutdownOptions = { commandMs: 1000, gracefulMs: 1000, termMs: 1000, killMs: 2000 };
const CLOCK: RpcClock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

interface PendingRequest {
  command: string;
  timer: unknown;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}
interface CompletionWaiter {
  after: number;
  accepted: boolean;
  timer: unknown;
  promise: Promise<RpcSettlement | null>;
  resolve: (settlement: RpcSettlement | null) => void;
  reject: (error: Error) => void;
}
interface QueuedWrite {
  bytes: Buffer;
  beforeWrite?: () => void;
}
interface UiWork {
  request: RpcUiRequest;
  controller: AbortController;
  timer: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1) {
    throw new Error(`RPC ${name} must be a positive finite integer below 2^31`);
  }
  return value;
}

/** Starts immediately; subscribe before sending prompts. No Pi runtime imports. */
export class RpcAgent {
  /** Resolves after owned-process cleanup, including automatic failure cleanup.
   * Always inspect result.error; this promise does not reject on transport failure.
   */
  readonly closed: Promise<RpcCloseResult>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly clock: RpcClock;
  private readonly limits: RpcLimits;
  private readonly shutdown: RpcShutdownOptions;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly detached: boolean;
  private readonly uiHandler: RpcAgentOptions["uiHandler"];
  private readonly prefix = randomUUID();
  private nextId = 0;
  private readonly listeners = new Set<(record: RpcRecord) => void>();
  private readonly removeListeners: Array<() => void> = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly waiters = new Set<CompletionWaiter>();
  private readonly writes: QueuedWrite[] = [];
  private writeBytes = 0;
  private backpressured = false;
  private ending = false;
  private readonly ui = new Map<string, UiWork>();
  private activeUi?: UiWork;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private readonly line: Buffer;
  private lineBytes = 0;
  private protocolBroken = false;
  private stderrBuffer = Buffer.alloc(0);
  private stderrWasTruncated = false;
  private accepting = true;
  private terminalError?: Error;
  private stopPromise?: Promise<RpcCloseResult>;
  private resolveClosed!: (result: RpcCloseResult) => void;
  private readonly childClosed: Promise<void>;
  private resolveChildClosed!: () => void;
  private didExit = false;
  private didClose = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private generation = 0;
  private settled = false;
  private lastSettlement?: RpcSettlement;

  constructor(options: RpcAgentOptions) {
    this.clock = options.dependencies?.clock ?? CLOCK;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.shutdown = { ...DEFAULT_SHUTDOWN, ...options.shutdown };
    for (const [key, value] of Object.entries({ ...this.limits, ...this.shutdown })) positive(value, key);
    this.line = Buffer.alloc(this.limits.recordBytes);
    this.uiHandler = options.uiHandler;
    this.detached = (options.dependencies?.platform ?? process.platform) !== "win32";
    this.signalProcess = options.dependencies?.signalProcess ?? process.kill;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.childClosed = new Promise((resolve) => { this.resolveChildClosed = resolve; });
    // A synchronous spawn exception is returned directly to the constructor's caller.
    this.child = (options.dependencies?.spawn ?? spawn)(options.invocation.command, [...options.invocation.args], {
      cwd: options.cwd, env: { ...options.env }, shell: false,
      stdio: ["pipe", "pipe", "pipe"], detached: this.detached, windowsHide: true,
    });
    this.listen(this.child.stdout, "data", (chunk: Buffer) => this.readStdout(chunk));
    this.listen(this.child.stdout, "end", () => {
      if (this.lineBytes) this.fail(new Error("RPC stdout ended with an incomplete record"));
    });
    this.listen(this.child.stdout, "error", (error: Error) => this.fail(new Error(`RPC stdout: ${error.message}`)));
    this.listen(this.child.stderr, "data", (chunk: Buffer) => this.readStderr(chunk));
    this.listen(this.child.stderr, "error", (error: Error) => this.fail(new Error(`RPC stderr: ${error.message}`)));
    this.listen(this.child.stdin, "drain", () => { this.backpressured = false; this.pumpWrites(); });
    this.listen(this.child.stdin, "error", (error: Error) => this.fail(new Error(`RPC stdin: ${error.message}`)));
    this.listen(this.child, "error", (error: Error) => this.fail(new Error(`RPC subprocess: ${error.message}`)));
    this.listen(this.child, "exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.didExit = true;
      this.exitCode = code;
      this.exitSignal = signal;
      if (this.accepting) this.fail(new Error(`RPC subprocess exited unexpectedly (${code ?? signal})`));
    });
    this.listen(this.child, "close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.didClose = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.resolveChildClosed();
      if (this.accepting) this.fail(new Error(`RPC subprocess closed unexpectedly (${code ?? signal})`));
      this.rejectOutstanding(this.terminalError ?? new Error("RPC subprocess closed"));
    });
  }

  get failure(): Error | undefined { return this.terminalError; }
  get stderr(): string { return this.stderrBuffer.toString("utf8"); }
  get stderrTruncated(): boolean { return this.stderrWasTruncated; }
  get state(): {
    accepting: boolean; isSettled: boolean; settledGeneration: number;
    pendingRequests: number; completionWaiters: number; queuedWrites: number;
    queuedWriteBytes: number; pendingUi: number;
  } {
    return {
      accepting: this.accepting, isSettled: this.settled, settledGeneration: this.generation,
      pendingRequests: this.pending.size, completionWaiters: this.waiters.size,
      queuedWrites: this.writes.length, queuedWriteBytes: this.writeBytes, pendingUi: this.ui.size,
    };
  }

  /** Synchronous observation only. Schedule reasoning/UI elsewhere; never block this callback. */
  onRecord(listener: (record: RpcRecord) => void): () => void {
    if (this.didClose) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  request(command: string, fields: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<RpcResponse> {
    return this.sendRequest(command, fields, options.timeoutMs ?? this.limits.requestTimeoutMs, false);
  }

  async prompt(message: string, options: RpcPromptOptions = {}): Promise<RpcPromptResult> {
    if (!this.accepting) throw this.terminalError ?? new Error("RPC transport is stopping");
    // Infinity means unarmed. A preceding run may settle while this prompt is
    // waiting for stdin drain; only settlements after its actual write count.
    const waiter = this.completion(Infinity, options.completionTimeoutMs ?? this.limits.completionTimeoutMs, false);
    try {
      const fields: Record<string, unknown> = { message };
      if (options.streamingBehavior) fields.streamingBehavior = options.streamingBehavior;
      if (options.images) fields.images = options.images;
      const response = await this.sendRequest("prompt", fields, options.timeoutMs ?? this.limits.requestTimeoutMs, false, () => {
        waiter.after = this.generation;
      });
      const disposition = isObject(response.data) ? response.data.disposition : undefined;
      if (disposition !== "started" && disposition !== "queued" && disposition !== "handled") {
        const error = new Error("RPC prompt response has an invalid disposition");
        this.fail(error);
        throw error;
      }
      waiter.accepted = true;
      if (disposition === "handled") {
        this.finishWaiter(waiter, null);
      } else if (this.settled && this.lastSettlement && this.generation > waiter.after) {
        this.finishWaiter(waiter, { ...this.lastSettlement });
      } else {
        // A previous run may settle after the write but before prompt handling.
        // If another run has since started, require its fresh settlement.
        waiter.after = this.generation;
        this.settled = false;
      }
      return { disposition, response, settled: waiter.promise };
    } catch (error) {
      this.finishWaiter(waiter, null, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async promptAndWait(message: string, options: RpcPromptOptions = {}): Promise<{
    disposition: RpcPromptDisposition; settlement: RpcSettlement | null;
  }> {
    const result = await this.prompt(message, options);
    return { disposition: result.disposition, settlement: await result.settled };
  }

  waitForSettled(options: { afterGeneration?: number; timeoutMs?: number } = {}): Promise<RpcSettlement> {
    if (!this.accepting) return Promise.reject(this.terminalError ?? new Error("RPC transport is stopping"));
    const after = options.afterGeneration ?? this.generation;
    if (!Number.isSafeInteger(after) || after < 0) return Promise.reject(new Error("RPC invalid settled generation"));
    if (this.lastSettlement && this.lastSettlement.generation > after) return Promise.resolve({ ...this.lastSettlement });
    return this.completion(after, options.timeoutMs ?? this.limits.completionTimeoutMs).promise as Promise<RpcSettlement>;
  }

  /** Returns false for expired/already-answered dialogs. IDs cannot address commands. */
  replyUi(id: string, reply: RpcUiReply): boolean {
    const work = this.ui.get(id);
    if (!work) return false;
    this.ui.delete(id);
    this.clock.clearTimeout(work.timer);
    work.controller.abort();
    let fields: RpcUiReply;
    if ("cancelled" in reply && reply.cancelled === true) fields = { cancelled: true };
    else if (work.request.method === "confirm" && "confirmed" in reply && typeof reply.confirmed === "boolean") fields = { confirmed: reply.confirmed };
    else if (work.request.method !== "confirm" && "value" in reply && typeof reply.value === "string") fields = { value: reply.value };
    else {
      this.fail(new Error("RPC invalid UI response"));
      return false;
    }
    if (!this.didExit && !this.ending && !this.terminalError) {
      this.enqueue({ type: "extension_ui_response", id, ...fields });
    }
    return true;
  }

  /** Close admission immediately. This exact promise also backs automatic failure cleanup. */
  stop(): Promise<RpcCloseResult> {
    if (this.stopPromise) return this.stopPromise;
    this.accepting = false;
    this.stopPromise = this.closed;
    this.rejectOutstanding(this.terminalError ?? new Error("RPC transport is stopping"));
    for (const id of this.ui.keys()) this.replyUi(id, { cancelled: true });
    this.activeUi?.controller.abort();
    void this.shutdownChild().then(this.resolveClosed);
    return this.stopPromise;
  }

  private listen(emitter: NodeJS.EventEmitter, event: string, listener: (...args: any[]) => void): void {
    emitter.on(event, listener);
    this.removeListeners.push(() => { emitter.removeListener(event, listener); });
  }

  private fail(error: Error): void {
    if (!this.terminalError) this.terminalError = error;
    this.rejectOutstanding(this.terminalError);
    void this.stop();
  }

  private rejectOutstanding(error: Error): void {
    for (const request of this.pending.values()) {
      this.clock.clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) this.finishWaiter(waiter, null, error);
    this.writes.length = 0;
    this.writeBytes = 0;
  }

  private sendRequest(command: string, fields: Record<string, unknown>, timeoutMs: number, internal: boolean, beforeWrite?: () => void): Promise<RpcResponse> {
    if (this.terminalError || this.didExit || (!internal && !this.accepting)) {
      return Promise.reject(this.terminalError ?? new Error("RPC transport is stopping"));
    }
    positive(timeoutMs, "request timeout");
    if (this.pending.size >= this.limits.pendingRequests) {
      this.fail(new Error("RPC pending request limit exceeded"));
      return Promise.reject(this.terminalError);
    }
    const id = `${this.prefix}:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        const error = new Error(`RPC ${command} timed out`);
        if (internal) {
          this.pending.delete(id);
          reject(error);
        } else this.fail(error); // Delivery is ambiguous; do not accept further work.
      }, timeoutMs);
      this.pending.set(id, { command, timer, resolve, reject });
      this.enqueue({ ...fields, type: command, id }, beforeWrite);
    });
  }

  private enqueue(record: RpcRecord, beforeWrite?: () => void): void {
    try {
      const bytes = Buffer.from(JSON.stringify(record) + "\n");
      if (bytes.length - 1 > this.limits.recordBytes || this.writes.length >= this.limits.queuedWrites ||
          this.writeBytes + bytes.length + this.child.stdin.writableLength > this.limits.queuedWriteBytes) {
        throw new Error("RPC queued write/record limit exceeded");
      }
      this.writes.push({ bytes, beforeWrite });
      this.writeBytes += bytes.length;
      this.pumpWrites();
    } catch (error) {
      this.fail(new Error(`RPC write failed: ${errorMessage(error)}`));
    }
  }

  private pumpWrites(): void {
    if (this.terminalError || this.didExit) return;
    try {
      while (!this.backpressured && this.writes.length) {
        const write = this.writes.shift()!;
        this.writeBytes -= write.bytes.length;
        write.beforeWrite?.();
        this.backpressured = !this.child.stdin.write(write.bytes);
      }
      if (this.ending && this.writes.length === 0 && !this.child.stdin.writableEnded) this.child.stdin.end();
    } catch (error) {
      this.fail(new Error(`RPC stdin write: ${errorMessage(error)}`));
    }
  }

  private readStdout(chunk: Buffer): void {
    // Keep consuming even after corruption or during shutdown. Decode complete
    // byte-framed records strictly; split UTF-8 sequences never become replacements.
    if (this.protocolBroken) return;
    try {
      let offset = 0;
      while (offset < chunk.length && !this.protocolBroken) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const length = this.lineBytes + end - offset;
        if (length > this.limits.recordBytes) throw new Error("record byte limit exceeded");
        if (newline === -1 && length > this.limits.incompleteBytes) throw new Error("incomplete-line byte limit exceeded");
        chunk.copy(this.line, this.lineBytes, offset, end);
        this.lineBytes = length;
        if (newline === -1) break;
        const lineEnd = length && this.line[length - 1] === 13 ? length - 1 : length;
        const text = this.decoder.decode(this.line.subarray(0, lineEnd));
        this.lineBytes = 0;
        const record: unknown = JSON.parse(text);
        if (!isObject(record) || typeof record.type !== "string" || !record.type) throw new Error("record must be an object with a type");
        this.receive(record as RpcRecord);
        offset = newline + 1;
      }
    } catch (error) {
      this.protocolBroken = true;
      this.lineBytes = 0;
      this.fail(new Error(`RPC protocol: ${errorMessage(error)}`));
    }
  }

  private receive(record: RpcRecord): void {
    if (record.type === "response") {
      if (typeof record.id !== "string" || typeof record.command !== "string" || typeof record.success !== "boolean" ||
          (!record.success && typeof record.error !== "string")) throw new Error("malformed command response");
      const request = this.pending.get(record.id);
      if (!request) {
        if (!this.accepting) return; // Replies to work rejected by stop may still be in flight.
        throw new Error(`unknown response ID: ${record.id}`);
      }
      if (request.command !== record.command) throw new Error("response command mismatch");
      this.pending.delete(record.id);
      this.clock.clearTimeout(request.timer);
      if (record.success) request.resolve(record as RpcResponse);
      else request.reject(new RpcCommandError(record as RpcResponse));
    } else if (record.type === "agent_settled") {
      if (typeof record.aborted !== "boolean") throw new Error("malformed agent_settled");
      this.lastSettlement = { generation: ++this.generation, observedAt: this.clock.now(), aborted: record.aborted };
      this.settled = true;
      for (const waiter of this.waiters) {
        if (waiter.accepted && this.generation > waiter.after) this.finishWaiter(waiter, { ...this.lastSettlement });
      }
    } else if (record.type === "agent_start") {
      this.settled = false;
    } else if (record.type === "queue_update") {
      if (!Array.isArray(record.steering) || !Array.isArray(record.followUp)) throw new Error("malformed queue_update");
      if (record.steering.length || record.followUp.length) this.settled = false;
    } else if (record.type === "extension_ui_request") {
      if (typeof record.id !== "string" || !record.id || typeof record.method !== "string") throw new Error("malformed UI request");
      if (DIALOGS.has(record.method)) this.queueUi(record as RpcUiRequest);
    }
    // Responses, UI records, and unknown future events retain their distinct type.
    // Returning a promise is a caller bug: there is no unbounded async event queue.
    for (const listener of this.listeners) {
      const result = listener(record) as unknown;
      if (isObject(result) && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error("onRecord listeners must be synchronous; schedule asynchronous work separately");
      }
    }
  }

  private completion(after: number, timeoutMs: number, accepted = true): CompletionWaiter {
    positive(timeoutMs, "completion timeout");
    if (this.waiters.size >= this.limits.completionWaiters) {
      const error = new Error("RPC completion waiter limit exceeded");
      this.fail(error);
      throw error;
    }
    let resolve!: CompletionWaiter["resolve"];
    let reject!: CompletionWaiter["reject"];
    const promise = new Promise<RpcSettlement | null>((yes, no) => { resolve = yes; reject = no; });
    // A fast failure may precede prompt acceptance and exposure of this promise.
    void promise.catch(() => {});
    const waiter: CompletionWaiter = { after, accepted, promise, resolve, reject, timer: undefined };
    waiter.timer = this.clock.setTimeout(() => this.fail(new Error("RPC settlement timed out")), timeoutMs);
    this.waiters.add(waiter);
    return waiter;
  }

  private finishWaiter(waiter: CompletionWaiter, settlement: RpcSettlement | null, error?: Error): void {
    if (!this.waiters.delete(waiter)) return;
    this.clock.clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(settlement);
  }

  private queueUi(request: RpcUiRequest): void {
    if (this.ui.has(request.id) || this.activeUi?.request.id === request.id) throw new Error("duplicate UI request ID");
    const expiredActive = this.activeUi && !this.ui.has(this.activeUi.request.id) ? 1 : 0;
    if (this.ui.size + expiredActive >= this.limits.uiRequests) throw new Error("UI request limit exceeded");
    const work: UiWork = { request, controller: new AbortController(), timer: undefined };
    let timeoutMs = this.limits.uiTimeoutMs;
    if (typeof request.timeout === "number" && Number.isFinite(request.timeout) && request.timeout > 0) {
      timeoutMs = Math.min(timeoutMs, request.timeout);
    }
    work.timer = this.clock.setTimeout(() => this.replyUi(request.id, { cancelled: true }), timeoutMs);
    this.ui.set(request.id, work);
    if (!this.accepting) this.replyUi(request.id, { cancelled: true });
    else queueMicrotask(() => this.pumpUi());
  }

  private pumpUi(): void {
    if (this.activeUi) return;
    const work = this.ui.values().next().value;
    if (!work) return;
    if (!this.accepting || !this.uiHandler) {
      this.replyUi(work.request.id, { cancelled: true });
      queueMicrotask(() => this.pumpUi());
      return;
    }
    this.activeUi = work;
    void Promise.resolve().then(() => {
      if (!work.controller.signal.aborted) return this.uiHandler!(work.request, work.controller.signal);
    }).then((reply) => {
      if (this.ui.get(work.request.id) === work) this.replyUi(work.request.id, reply ?? { cancelled: true });
    }, (error: unknown) => {
      if (this.ui.get(work.request.id) === work) {
        this.replyUi(work.request.id, { cancelled: true });
        this.fail(new Error(`RPC UI handler: ${errorMessage(error)}`));
      }
    }).finally(() => {
      this.activeUi = undefined;
      this.pumpUi();
    });
  }

  private readStderr(chunk: Buffer): void {
    const limit = this.limits.stderrBytes;
    if (this.stderrBuffer.length + chunk.length > limit) this.stderrWasTruncated = true;
    if (chunk.length >= limit) this.stderrBuffer = Buffer.from(chunk.subarray(chunk.length - limit));
    else this.stderrBuffer = Buffer.concat([this.stderrBuffer.subarray(Math.max(0, this.stderrBuffer.length + chunk.length - limit)), chunk]);
    // Do not expose a partial leading UTF-8 code point after tail truncation.
    if (this.stderrWasTruncated) {
      let start = 0;
      while (start < this.stderrBuffer.length && (this.stderrBuffer[start] & 0xc0) === 0x80) start++;
      this.stderrBuffer = this.stderrBuffer.subarray(start);
    }
  }

  private groupExists(): boolean {
    if (!this.detached || !this.child.pid) return false;
    try {
      this.signalProcess(-this.child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true; // Permission/probe failures must not silently skip cleanup.
    }
  }

  private signalChild(signal: "SIGTERM" | "SIGKILL", errors: string[]): void {
    // The process group can outlive the direct child; never gate killpg on exitCode.
    if (this.detached && this.child.pid) {
      try {
        this.signalProcess(-this.child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(`RPC process group ${signal}: ${errorMessage(error)}`);
      }
    }
    if (!this.didExit) {
      try { this.child.kill(signal); } catch (error) { errors.push(`RPC child ${signal}: ${errorMessage(error)}`); }
    }
  }

  private waitForClose(ms: number): Promise<void> {
    if (this.didClose) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(resolve, ms);
      void this.childClosed.then(() => { this.clock.clearTimeout(timer); resolve(); });
    });
  }

  private async waitForGroup(ms: number): Promise<void> {
    const deadline = this.clock.now() + ms;
    while (this.groupExists() && this.clock.now() < deadline) {
      await new Promise<void>((resolve) => { this.clock.setTimeout(resolve, Math.min(20, deadline - this.clock.now())); });
    }
  }

  private async shutdownChild(): Promise<RpcCloseResult> {
    const signals: RpcCloseResult["signals"] = [];
    const shutdownErrors: string[] = [];
    try {
      if (!this.terminalError && !this.didExit) {
        try {
          // Never abort after an unacknowledged clear: abort can otherwise run
          // queued guidance. The fallback in that case is EOF and group signals.
          await this.sendRequest("clear_queue", {}, this.shutdown.commandMs, true);
          await this.sendRequest("abort", {}, this.shutdown.commandMs, true);
        } catch (error) {
          shutdownErrors.push(errorMessage(error));
        }
      }
      this.ending = true;
      if (!this.didExit) {
        if (this.terminalError || shutdownErrors.length) {
          this.writes.length = 0;
          this.writeBytes = 0;
          try {
            this.child.stdin.end();
          } catch (error) {
            this.fail(new Error(`RPC stdin close: ${errorMessage(error)}`));
          }
        } else this.pumpWrites();
      }
      await this.waitForClose(this.shutdown.gracefulMs);
      if (!this.didClose || this.groupExists()) {
        signals.push("SIGTERM");
        this.signalChild("SIGTERM", shutdownErrors);
        await Promise.all([this.waitForClose(this.shutdown.termMs), this.waitForGroup(this.shutdown.termMs)]);
      }
      if (!this.didClose || this.groupExists()) {
        signals.push("SIGKILL");
        this.signalChild("SIGKILL", shutdownErrors);
        await this.waitForClose(this.shutdown.killMs);
        // Grandchildren cannot be waitpid'd by this parent. KILL still reaches
        // them after child close; give the kernel a turn before resolving cleanup.
        await new Promise<void>((resolve) => { this.clock.setTimeout(resolve, 1); });
      }
      if (!this.didClose) throw new Error("RPC subprocess did not close after SIGKILL");
    } catch (error) {
      this.terminalError ??= new Error(`RPC shutdown: ${errorMessage(error)}`);
    } finally {
      this.rejectOutstanding(this.terminalError ?? new Error("RPC transport stopped"));
      for (const work of this.ui.values()) {
        this.clock.clearTimeout(work.timer);
        work.controller.abort();
      }
      this.ui.clear();
      this.activeUi?.controller.abort();
      // Keep draining if the OS could not close the process. Report failure, and
      // remove our stream listeners only once close actually arrives.
      const cleanup = (): void => {
        for (const remove of this.removeListeners) remove();
        this.removeListeners.length = 0;
        this.listeners.clear();
      };
      if (this.didClose) cleanup();
      else void this.childClosed.then(cleanup);
    }
    return { code: this.exitCode, signal: this.exitSignal, error: this.terminalError, stderr: this.stderr,
      stderrTruncated: this.stderrTruncated, signals, shutdownErrors };
  }
}
