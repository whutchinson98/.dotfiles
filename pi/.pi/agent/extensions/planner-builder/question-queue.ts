export type QuestionMethod = "select" | "confirm" | "input" | "editor";
export interface ParentQuestion {
  /** Parent-assigned owner (attempt/launch ID), never taken from child arguments. */
  owner: string;
  id: string;
  method: QuestionMethod;
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeoutMs?: number;
}
export type QuestionResult =
  | { status: "answered"; value: string | boolean }
  | { status: "cancelled" | "unavailable" | "timeout" | "error"; message?: string };
export interface QuestionQueueOptions {
  interactive: boolean | (() => boolean);
  /** Must dismiss the dialog on abort and resolve only after UI cleanup is complete. */
  show: (question: ParentQuestion, signal: AbortSignal) => Promise<string | boolean | undefined>;
  onWaitingStart?: (question: ParentQuestion) => void;
  onWaitingEnd?: (question: ParentQuestion, result: QuestionResult) => void;
  maxPending?: number;
  timeoutMs?: number;
}
export interface QuestionQueue {
  ask: (question: ParentQuestion, signal?: AbortSignal) => Promise<QuestionResult>;
  cancelOwner: (owner: string) => void;
  /** Cancels all owners and joins the active UI before resolving. Idempotent. */
  close: () => Promise<void>;
}
export interface RpcQuestionResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}

const MAX_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 300_000;
const METHODS: readonly string[] = ["select", "confirm", "input", "editor"];

function limit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid question limit");
  return value;
}

function validateQuestion(question: ParentQuestion): void {
  for (const field of [question.owner, question.id]) {
    if (typeof field !== "string" || !field || Buffer.byteLength(field) > 1024) throw new Error("Invalid question identity");
  }
  if (!METHODS.includes(question.method) || typeof question.title !== "string") throw new Error("Invalid question method or title");
  for (const field of [question.message, question.placeholder, question.prefill]) {
    if (field !== undefined && typeof field !== "string") throw new Error("Invalid question text");
  }
  if (question.method === "select" && (!Array.isArray(question.options) || question.options.length > 64 || question.options.some((value) => typeof value !== "string"))) {
    throw new Error("Invalid question options");
  }
  if (Buffer.byteLength(JSON.stringify(question)) > MAX_BYTES) throw new Error("Question size limit exceeded");
}

interface Entry {
  question: ParentQuestion;
  controller: AbortController;
  settled: boolean;
  finish: (result: QuestionResult) => void;
}

/** One instance is shared by every child in a build; no Pi/TUI dependencies are needed. */
export function createQuestionQueue(options: QuestionQueueOptions): QuestionQueue {
  const maxPending = limit(options.maxPending, 32, 128);
  const timeoutMs = limit(options.timeoutMs, MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const entries = new Set<Entry>();
  const queued: Entry[] = [];
  let active: Entry | undefined;
  let activeWork: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  async function show(entry: Entry): Promise<void> {
    try {
      if (entry.settled) return;
      const value = await options.show(entry.question, entry.controller.signal);
      if (entry.settled) return;
      if (value === undefined) {
        entry.finish({ status: "cancelled" });
        return;
      }
      const { method, options: choices } = entry.question;
      const valid = method === "confirm" ? typeof value === "boolean" : typeof value === "string";
      if (!valid || (method === "select" && !choices?.includes(value as string)) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) {
        entry.finish({ status: "error", message: "Invalid or oversized question answer" });
        return;
      }
      entry.finish({ status: "answered", value });
    } catch {
      entry.finish({ status: "error", message: "Parent question UI failed" });
    } finally {
      entries.delete(entry);
      active = undefined;
    }
  }

  function pump(): void {
    if (closed || active) return;
    const entry = queued.shift();
    if (!entry) return;
    active = entry;
    activeWork = Promise.resolve().then(() => show(entry)).then(pump);
  }

  async function ask(input: ParentQuestion, signal?: AbortSignal): Promise<QuestionResult> {
    validateQuestion(input);
    const question: ParentQuestion = { ...input, options: input.options?.slice() };
    const requestedTimeout = question.timeoutMs;
    if (requestedTimeout !== undefined && (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)) throw new Error("Invalid question timeout");
    const deadline = Math.min(requestedTimeout ?? timeoutMs, timeoutMs);
    if (closed || signal?.aborted) return { status: "cancelled" };
    const interactive = typeof options.interactive === "function" ? options.interactive() : options.interactive;
    if (!interactive) return { status: "unavailable", message: "User interaction is unavailable in this mode" };
    if (entries.size >= maxPending) return { status: "error", message: "Parent question queue is full" };
    if ([...entries].some((entry) => entry.question.owner === question.owner && entry.question.id === question.id)) {
      return { status: "error", message: "Duplicate parent question" };
    }
    return new Promise<QuestionResult>((resolve) => {
      const controller = new AbortController();
      let waiting = false;
      const entry: Entry = { question, controller, settled: false, finish };
      function finish(result: QuestionResult): void {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        const index = queued.indexOf(entry);
        if (index >= 0) queued.splice(index, 1);
        if (active !== entry) entries.delete(entry);
        // Resolve cancellation immediately, but keep the active slot until show() has joined.
        if (result.status !== "answered") controller.abort();
        if (waiting) {
          try {
            options.onWaitingEnd?.(question, result);
          } catch {
            result = { status: "error", message: "Question waiting-end callback failed" };
          }
        }
        resolve(result);
      }
      function cancel(): void { finish({ status: "cancelled" }); }
      const timer = setTimeout(() => finish({ status: "timeout" }), deadline);
      signal?.addEventListener("abort", cancel, { once: true });
      entries.add(entry);
      queued.push(entry);
      try {
        waiting = true;
        options.onWaitingStart?.(question);
      } catch {
        finish({ status: "error", message: "Question waiting-start callback failed" });
      }
      if (signal?.aborted) cancel();
      pump();
    });
  }

  function cancelOwner(owner: string): void {
    for (const entry of entries) {
      if (entry.question.owner === owner) entry.finish({ status: "cancelled" });
    }
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    for (const entry of entries) entry.finish({ status: "cancelled" });
    closing = (activeWork ?? Promise.resolve()).then(() => undefined);
    return closing;
  }

  return { ask, cancelOwner, close };
}

/** Dialog-only adapter. Notifications/status/widget updates deliberately produce no response. */
export async function handleRpcQuestion(queue: QuestionQueue, owner: string, record: unknown, signal?: AbortSignal): Promise<RpcQuestionResponse | undefined> {
  if (!record || typeof record !== "object") return undefined;
  const request = record as Record<string, unknown>;
  if (request.type !== "extension_ui_request" || !METHODS.includes(request.method as string)) return undefined;
  if (typeof request.id !== "string" || !request.id || Buffer.byteLength(request.id) > 1024) throw new Error("Invalid RPC question ID");
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_BYTES) throw new Error("RPC question size limit exceeded");
  const question: ParentQuestion = {
    owner, id: request.id, method: request.method as QuestionMethod,
    title: request.title as string,
    options: request.options as string[] | undefined,
    message: request.message as string | undefined,
    placeholder: request.placeholder as string | undefined,
    prefill: request.prefill as string | undefined,
    timeoutMs: request.timeout as number | undefined,
  };
  const answer = await queue.ask(question, signal);
  const response: RpcQuestionResponse = { type: "extension_ui_response", id: request.id };
  if (answer.status !== "answered") return { ...response, cancelled: true };
  if (question.method === "confirm") return { ...response, confirmed: answer.value as boolean };
  return { ...response, value: answer.value as string };
}
