import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  boundedText,
  isTerminalControl,
  normalizeAttempt,
  normalizeControl,
  reduceControl,
  SUPERVISION_LIMITS,
  validateIdentifier,
  validateIdentity,
  type AttemptRegistration,
  type ControlOrigin,
  type ControlRecord,
  type SessionMapping,
} from "./build-state.ts";

export const JOURNAL_SCHEMA_VERSION = 1;
export interface RunJournalOptions {
  /** A private per-run directory outside every source checkout and protected plan/report path. */
  runDirectory: string;
  runId: string;
  sourceRoots: readonly string[];
  protectedPaths: readonly string[];
  maxBytes?: number;
  maxRecordBytes?: number;
  now?: () => number;
  /** Test seam. A successful write must append the whole line and sync it before resolving. */
  write?: (handle: fs.FileHandle, line: string) => Promise<void>;
}
export interface JournalDecision {
  origin: ControlOrigin;
  reason: string;
  evidenceSequences: number[];
  taskId?: string;
  attemptId?: string;
}
export interface JournalStatus {
  bytesWritten: number;
  reservedBytes: number;
  pendingControls: number;
  canAcceptControls: boolean;
  disableReason?: string;
}
export class JournalCapacityError extends Error {
  constructor() { super("Decision journal capacity exhausted; new supervision controls are disabled"); this.name = "JournalCapacityError"; }
}
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function absolute(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Journal paths must be absolute");
  return path.resolve(value);
}
function validLimit(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > fallback) throw new Error("Invalid journal byte limit");
  return value;
}
function descriptorPath(handle: fs.FileHandle): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (process.platform === "darwin" || process.platform === "freebsd") return `/dev/fd/${handle.fd}`;
  throw new Error("Secure descriptor-relative journal creation is unavailable on this platform");
}
async function exists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

/** Hold directory descriptors while creating the journal; a renamed ancestor cannot redirect the write. */
async function createJournalFile(options: RunJournalOptions): Promise<{ handle: fs.FileHandle; runDirectory: string; filePath: string }> {
  const runDirectory = absolute(options.runDirectory);
  const protectedPaths = [...options.sourceRoots, ...options.protectedPaths].map(absolute);
  for (const protectedPath of protectedPaths) {
    const canonical = await fs.realpath(protectedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return protectedPath;
      throw error;
    });
    if (isWithin(protectedPath, runDirectory) || isWithin(canonical, runDirectory)) throw new Error("Journal cannot be beneath source or protected paths");
  }
  const parts = runDirectory.slice(path.parse(runDirectory).root.length).split(path.sep).filter(Boolean);
  if (!parts.length) throw new Error("Journal requires a private run directory");
  if (parts.some((part, index) => part.toLowerCase() === ".pi" && ["plans", "outputs"].includes(parts[index + 1]?.toLowerCase()))) {
    throw new Error("Journal cannot be beneath protected plan/report paths");
  }
  const directories: fs.FileHandle[] = [];
  let file: fs.FileHandle | undefined;
  try {
    directories.push(await fs.open(path.parse(runDirectory).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of parts) {
      const parent = descriptorPath(directories[directories.length - 1]);
      for (const marker of [".git", ".jj"]) {
        if (await exists(path.join(parent, marker))) throw new Error("Journal cannot be beneath a source checkout");
      }
      const child = path.join(parent, part);
      await fs.mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if ((await fs.lstat(child)).isSymbolicLink()) throw new Error("Journal directory symlinks are not allowed");
      directories.push(await fs.open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    const directory = directories[directories.length - 1];
    if ((await directory.stat()).mode & 0o077) throw new Error("Journal run directory must have private permissions (0700)");
    const anchored = descriptorPath(directory);
    for (const marker of [".git", ".jj"]) {
      if (await exists(path.join(anchored, marker))) throw new Error("Journal cannot be in a source checkout");
    }
    file = await fs.open(path.join(anchored, "decisions.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await directory.sync();
    return { handle: file, runDirectory, filePath: path.join(runDirectory, "decisions.jsonl") };
  } catch (error) {
    await file?.close();
    throw error;
  } finally {
    await Promise.all(directories.map((directory) => directory.close()));
  }
}

async function writeLine(handle: fs.FileHandle, line: string): Promise<void> {
  await handle.writeFile(line, "utf8");
  await handle.sync();
}
function evidence(sequences: number[]): { evidenceSequences: number[]; evidenceTruncated: boolean } {
  if (!Array.isArray(sequences)) throw new Error("Invalid journal evidence sequences");
  const selected = sequences.slice(0, SUPERVISION_LIMITS.evidenceSequences);
  if (selected.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)) throw new Error("Invalid journal evidence sequence");
  return { evidenceSequences: selected, evidenceTruncated: selected.length < sequences.length };
}
function validateOrigin(origin: ControlOrigin): void {
  if (!["runner", "manual", "supervisor"].includes(origin)) throw new Error("Invalid journal origin");
}
function reason(text: string): ReturnType<typeof boundedText> {
  if (typeof text !== "string") throw new Error("Invalid journal reason");
  return boundedText(text, SUPERVISION_LIMITS.reasonBytes);
}

/** Bound encoded JSON bytes too: escaping can expand a one-byte character to six bytes. */
function encodeRecord(record: Record<string, unknown>, maximum: number): string {
  const bounded = structuredClone(record);
  let line = JSON.stringify(bounded) + "\n";
  const reason = bounded.reason as ReturnType<typeof boundedText> | undefined;
  const sequences = bounded.evidenceSequences as number[] | undefined;
  while (Buffer.byteLength(line) > maximum) {
    if (reason?.text) {
      reason.text = boundedText(reason.text, Math.floor(Buffer.byteLength(reason.text) / 2)).text;
      reason.truncated = true;
      bounded.reasonTruncated = true;
    } else if (sequences?.length) {
      sequences.length = Math.floor(sequences.length / 2);
      bounded.evidenceTruncated = true;
    } else {
      throw new Error("Journal record exceeds byte limit");
    }
    line = JSON.stringify(bounded) + "\n";
  }
  return line;
}

/** Append-only decisions, not a transcript or crash-recovery mechanism. Never reopen an existing journal. */
export class RunJournal {
  readonly runDirectory: string;
  readonly path: string;
  readonly runId: string;
  private readonly handle: fs.FileHandle;
  private readonly maxBytes: number;
  private readonly maxRecordBytes: number;
  private readonly now: () => number;
  private readonly write: (handle: fs.FileHandle, line: string) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private bytesWritten = 0;
  private controls = new Map<string, ControlRecord>();
  private pending = new Set<string>();
  private disableReason?: string;
  private failure?: Error;
  private closing = false;
  private closePromise?: Promise<void>;

  private constructor(options: RunJournalOptions, file: { handle: fs.FileHandle; runDirectory: string; filePath: string }, maxBytes: number, maxRecordBytes: number) {
    this.handle = file.handle;
    this.runDirectory = file.runDirectory;
    this.path = file.filePath;
    this.runId = options.runId;
    this.maxBytes = maxBytes;
    this.maxRecordBytes = maxRecordBytes;
    this.now = options.now ?? Date.now;
    this.write = options.write ?? writeLine;
  }

  static async open(options: RunJournalOptions): Promise<RunJournal> {
    validateIdentifier(options.runId, "Run ID");
    if (!Array.isArray(options.sourceRoots) || !Array.isArray(options.protectedPaths)) throw new Error("Source roots and protected paths must be supplied explicitly");
    const maxBytes = validLimit(options.maxBytes, SUPERVISION_LIMITS.journalBytes, 4096);
    const maxRecordBytes = validLimit(options.maxRecordBytes, SUPERVISION_LIMITS.journalRecordBytes, 2048);
    if (maxBytes < maxRecordBytes * 2) throw new Error("Journal capacity must fit acceptance and terminal reservation");
    return new RunJournal(options, await createJournalFile(options), maxBytes, maxRecordBytes);
  }

  get status(): Readonly<JournalStatus> {
    return Object.freeze({ bytesWritten: this.bytesWritten, reservedBytes: this.reservedBytes, pendingControls: this.pending.size, canAcceptControls: !this.closing && !this.disableReason && !this.failure, disableReason: this.disableReason });
  }

  private get reservedBytes(): number { return this.pending.size * this.maxRecordBytes; }

  async recordDecision(decision: JournalDecision): Promise<void> {
    validateOrigin(decision.origin);
    if (decision.taskId !== undefined) validateIdentifier(decision.taskId, "Task ID");
    if (decision.attemptId !== undefined) validateIdentifier(decision.attemptId, "Attempt ID");
    const record = { kind: "decision", origin: decision.origin, taskId: decision.taskId, attemptId: decision.attemptId, reason: reason(decision.reason), ...evidence(decision.evidenceSequences) };
    return this.enqueue(() => this.append(record));
  }

  async recordAttempt(input: AttemptRegistration): Promise<void> {
    const attempt = normalizeAttempt(input);
    if (attempt.runId !== this.runId) throw new Error("Attempt belongs to a different run");
    return this.enqueue(() => this.append({ ...attempt, kind: "attempt" }));
  }

  async recordSession(mapping: SessionMapping): Promise<void> {
    if (mapping.runId !== this.runId) throw new Error("Session mapping belongs to a different run");
    validateIdentifier(mapping.sessionId, "Session ID");
    if (mapping.role !== "builder" && mapping.role !== "supervisor") throw new Error("Invalid session role");
    if (mapping.role === "builder") {
      validateIdentity(mapping as Required<SessionMapping>);
      if (!Number.isSafeInteger(mapping.attemptNumber) || mapping.attemptNumber! < 1) throw new Error("Invalid session attempt number");
    }
    if (mapping.workspacePath !== undefined && (typeof mapping.workspacePath !== "string" || Buffer.byteLength(mapping.workspacePath) > 4096)) throw new Error("Invalid session workspace path");
    const record = {
      kind: "session", role: mapping.role, sessionId: mapping.sessionId, sessionFile: mapping.sessionFile,
      taskId: mapping.taskId, attemptId: mapping.attemptId, attemptNumber: mapping.attemptNumber, workspacePath: mapping.workspacePath,
    };
    return this.enqueue(async () => {
      if (record.sessionFile !== undefined) {
        const sessionFile = absolute(record.sessionFile);
        if (sessionFile === this.runDirectory || !isWithin(this.runDirectory, sessionFile) || sessionFile === this.path) throw new Error("Session file must be inside the run directory");
        let candidate = sessionFile;
        while (candidate !== this.runDirectory) {
          if (await exists(candidate) && (await fs.lstat(candidate)).isSymbolicLink()) throw new Error("Session file symlinks are not allowed");
          candidate = path.dirname(candidate);
        }
      }
      await this.append(record);
    });
  }

  async recordControl(input: ControlRecord): Promise<void> {
    const control = normalizeControl(input);
    if (control.runId !== this.runId) throw new Error("Control belongs to a different run");
    const record = {
      ...control, kind: "control", reason: reason(input.reason),
      evidenceTruncated: control.evidenceTruncated, reasonTruncated: control.reasonTruncated,
    };
    return this.enqueue(async () => {
      const previous = this.controls.get(control.controlId);
      if (previous) {
        if (previous.taskId !== control.taskId || previous.attemptId !== control.attemptId || previous.origin !== control.origin || previous.createdAt !== control.createdAt) throw new Error("Control identity changed");
        reduceControl(previous, control.status, control.updatedAt);
      } else if (!["proposed", "accepted", "rejected", "cancelled"].includes(control.status)) {
        throw new Error("Control transition requires an existing acceptance");
      }
      const reserve = control.status === "accepted";
      const terminal = isTerminalControl(control.status) && this.pending.has(control.controlId);
      // Terminal writes spend only their own reservation, even after new admission was disabled.
      await this.append(record, reserve, terminal);
      this.controls.set(control.controlId, control);
      if (reserve) this.pending.add(control.controlId);
      if (terminal) this.pending.delete(control.controlId);
      this.checkAdmission();
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Decision journal is closed"));
    const result = this.tail.then(() => {
      if (this.failure) throw this.failure;
      return operation();
    });
    // The returned promise reports every error. The scheduling tail alone absorbs rejection.
    this.tail = result.catch(() => {});
    return result;
  }

  private async append(record: Record<string, unknown>, reserve = false, terminal = false): Promise<void> {
    const observedAt = this.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("Invalid journal timestamp");
    const line = encodeRecord({ ...record, schemaVersion: JOURNAL_SCHEMA_VERSION, runId: this.runId, sequence: this.sequence + 1, observedAt }, this.maxRecordBytes);
    const bytes = Buffer.byteLength(line);
    let reservation = this.reservedBytes;
    if (reserve) reservation += this.maxRecordBytes;
    if (terminal) reservation -= this.maxRecordBytes;
    if ((!terminal && this.disableReason) || this.bytesWritten + bytes + reservation > this.maxBytes) {
      this.disableReason ??= new JournalCapacityError().message;
      throw new JournalCapacityError();
    }
    try {
      await this.write(this.handle, line);
    } catch (cause) {
      this.failure = new Error(`Decision journal write failed: ${String(cause)}`, { cause });
      this.disableReason = this.failure.message;
      throw this.failure;
    }
    this.sequence++;
    this.bytesWritten += bytes;
    // Control reservation changes happen only after successful persistence in recordControl.
    if (!reserve && !terminal) this.checkAdmission();
  }

  private checkAdmission(): void {
    if (this.maxBytes - this.bytesWritten - this.reservedBytes < 2 * this.maxRecordBytes) {
      this.disableReason ??= new JournalCapacityError().message;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      await this.handle.close();
      if (this.failure) throw this.failure;
    });
    return this.closePromise;
  }
}
