import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface EvidenceWorkspace {
  runId: string;
  taskId: string;
  attemptId: string;
  rootPath: string;
  vcs: "jj" | "git";
  /** Parent-resolved immutable commit hash, never a child-supplied revision expression. */
  baseRevision: string;
  /** Workspace-relative files or directory prefixes (including the active plan/report). */
  protectedPaths: readonly string[];
}
export type TaskEvidenceRequest =
  | { kind: "file"; path: string; startLine?: number; maxLines?: number; maxBytes?: number }
  | { kind: "diff"; path: string; maxBytes?: number };
export interface TaskEvidence {
  runId: string;
  taskId: string;
  attemptId: string;
  kind: "file" | "diff";
  path: string;
  text: string;
  observedAt: string;
  completedAt: string;
  truncated: boolean;
  concurrentChangesPossible: true;
  integrationValidation: false;
  notes: string[];
}
export interface TaskEvidenceOptions {
  spawn?: typeof spawn;
  now?: () => Date;
  timeoutMs?: number;
}
export interface TaskEvidenceReader {
  read: (request: TaskEvidenceRequest, signal?: AbortSignal) => Promise<TaskEvidence>;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 8192;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_LIFETIME_BYTES = 4 * 1024 * 1024;
const METADATA = new Set([".git", ".jj", ".hg", ".svn"]);

function limit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Evidence limit is invalid or excessive");
  return value;
}

function relativeParts(file: string): string[] {
  if (typeof file !== "string" || !file || Buffer.byteLength(file) > 1024 || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || /[\\\x00-\x1f\x7f]/.test(file)) {
    throw new Error("Evidence requires a bounded, relative path");
  }
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Evidence path traversal is not allowed");
  return parts;
}

function validatePath(file: string, protectedPaths: readonly string[]): string[] {
  const parts = relativeParts(file);
  if (parts.some((part) => METADATA.has(part.toLowerCase()))) throw new Error("Evidence metadata paths are not allowed");
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part, index) => part === ".pi" && ["plans", "outputs"].includes(lowerParts[index + 1]))) {
    throw new Error("Evidence protected plan/report path");
  }
  const lowerFile = file.toLowerCase();
  if (protectedPaths.some((protectedPath) => lowerFile === protectedPath.toLowerCase() || lowerFile.startsWith(`${protectedPath.toLowerCase()}/`))) {
    throw new Error("Evidence protected path");
  }
  return parts;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Anchored directory descriptors prevent a concurrently replaced ancestor from redirecting a read.
 * Fail closed on hosts without descriptor-relative filesystem paths; do not fall back to realpath/open races.
 * All symlinks (including contained ones) are deliberately refused. */
function descriptorPath(handle: fs.FileHandle): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (process.platform === "darwin" || process.platform === "freebsd") return `/dev/fd/${handle.fd}`;
  throw new Error("Secure descriptor-relative file evidence is unavailable on this platform");
}

async function readWorkspaceFile(root: string, parts: string[], allowMissing: boolean, consume: (bytes: number) => void, signal?: AbortSignal): Promise<string | undefined> {
  const directories: fs.FileHandle[] = [];
  let file: fs.FileHandle | undefined;
  try {
    directories.push(await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (let index = 0; index < parts.length; index++) {
      signal?.throwIfAborted();
      const parent = descriptorPath(directories[directories.length - 1]);
      const candidate = `${parent}/${parts[index]}`;
      const stat = await fs.lstat(candidate).catch((error) => {
        if (allowMissing && isMissing(error)) return undefined;
        throw error;
      });
      if (!stat) return undefined;
      if (stat.isSymbolicLink()) throw new Error("Evidence symlink paths are not allowed");
      if (index < parts.length - 1) {
        if (!stat.isDirectory()) throw new Error("Evidence ancestor is not a directory");
        const directory = await fs.open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        directories.push(directory);
        for (const marker of METADATA) {
          const exists = await fs.lstat(`${descriptorPath(directory)}/${marker}`).then(() => true, (error) => {
            if (isMissing(error)) return false;
            throw error;
          });
          if (exists) throw new Error("Evidence cannot cross a nested checkout boundary");
        }
      } else {
        if (!stat.isFile()) throw new Error("Evidence requires a regular text file");
        file = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
    }
    if (!file) throw new Error("Evidence requires a regular file");
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Evidence requires a regular text file");
    if (stat.size > MAX_FILE_BYTES) throw new Error("Evidence file size limit exceeded");
    consume(stat.size + 1);
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > stat.size) throw new Error("Evidence file changed size during observation; retry later");
    const bytes = buffer.subarray(0, total);
    if (bytes.some((byte) => byte === 127 || (byte < 32 && ![9, 10, 12, 13].includes(byte)))) throw new Error("Binary file evidence is not allowed");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Evidence requires UTF-8 text, not binary data");
    }
  } finally {
    await Promise.all([file?.close(), ...directories.map((directory) => directory.close())]);
  }
}

function textPrefix(text: string, maximum: number): string {
  // Streaming decode drops an incomplete final code point without inserting a replacement character.
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text).subarray(0, maximum), { stream: true });
}

function diffInvocation(workspace: EvidenceWorkspace, root: string, file: string): { command: string; args: string[] } {
  if (!/^[0-9a-f]{40,64}$/.test(workspace.baseRevision)) throw new Error("Evidence requires a trusted full base revision hash");
  if (workspace.vcs === "jj") {
    return { command: "jj", args: [
      "--no-pager", "--ignore-working-copy", "--at-operation=@", "--color=never", "--repository", root,
      "diff", "--git", "--context=3", "--from", workspace.baseRevision, "--to", "@", "--", `root-file:${JSON.stringify(file)}`,
    ] };
  }
  return { command: "git", args: [
    "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false",
    "-c", "diff.external=", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", "--ignore-submodules=none",
    // Comparing stored trees also avoids worktree clean filters, which --no-textconv alone does not disable.
    "--no-color", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", workspace.baseRevision, "HEAD", "--", file,
  ] };
}

function diffEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|JJ_)/.test(key)) delete env[key];
  }
  return {
    ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", JJ_CONFIG: "/dev/null", PAGER: "cat", LC_ALL: "C",
  };
}

async function runDiff(workspace: EvidenceWorkspace, root: string, file: string, maximum: number, timeoutMs: number, spawnProcess: typeof spawn, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  signal?.throwIfAborted();
  const { command, args } = diffInvocation(workspace, root, file);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: root, env: diffEnvironment(), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let truncated = false;
    let failure: Error | undefined;
    function kill(): void {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
        }
      }
      child.kill("SIGKILL");
    }
    function cancel(): void {
      failure = new Error("Evidence diff aborted");
      kill();
    }
    const timer = setTimeout(() => {
      failure = new Error("Evidence diff timeout");
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      const remaining = maximum - size;
      if (remaining > 0) {
        chunks.push(Buffer.from(chunk.subarray(0, remaining)));
        size += Math.min(chunk.length, remaining);
      }
      if (chunk.length > remaining) {
        truncated = true;
        kill();
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 2048) {
        failure = new Error("Evidence diff diagnostic output limit exceeded");
        kill();
      }
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure) { reject(failure); return; }
      if (code !== 0 && !truncated) { reject(new Error("Evidence diff failed")); return; }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks), { stream: truncated });
        resolve({ text, truncated });
      } catch {
        reject(new Error("Evidence diff is not UTF-8 text"));
      }
    });
    if (signal?.aborted) cancel();
  });
}

function validateDiff(text: string, file: string): void {
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new Error("Binary diff evidence is not allowed");
  // Check headers before returning any content: even a repository fileset alias must not widen scope.
  const expected = `diff --git a/${file} b/${file}`;
  if (text && !text.startsWith(`${expected}\n`)) throw new Error("Evidence diff path scope could not be verified");
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ") && line !== expected) throw new Error("Evidence diff contains another path");
    if (/^(rename|copy) (from|to) /.test(line)) throw new Error("Evidence diff contains a renamed/copied path; use file evidence");
    if (/^(Binary files |Binary file |GIT binary patch)/.test(line)) throw new Error("Binary diff evidence is not allowed");
    const mode = /^(?:(?:old|new) mode |(?:deleted|new) file mode |index \S+ )(\d{6})$/.exec(line)?.[1];
    if (mode && mode !== "100644" && mode !== "100755") throw new Error("Evidence diff requires regular files");
  }
}

/** Inspection is bounded evidence only. It does not snapshot jj or grant integration readiness. */
export function createTaskEvidence(input: EvidenceWorkspace, options: TaskEvidenceOptions = {}): TaskEvidenceReader {
  const workspace = { ...input, protectedPaths: [...input.protectedPaths] };
  if (!path.isAbsolute(workspace.rootPath) || !["jj", "git"].includes(workspace.vcs)) throw new Error("Invalid parent workspace metadata");
  for (const id of [workspace.runId, workspace.taskId, workspace.attemptId]) {
    if (!id || Buffer.byteLength(id) > 256) throw new Error("Invalid parent evidence identity");
  }
  for (const protectedPath of workspace.protectedPaths) relativeParts(protectedPath);
  const now = options.now ?? (() => new Date());
  const timeoutMs = limit(options.timeoutMs, 5000, 10_000);
  let outstanding = 0;
  let requests = 0;
  let remainingBytes = MAX_LIFETIME_BYTES;
  function consume(bytes: number): void {
    if (bytes > remainingBytes) throw new Error("Evidence cumulative read limit exceeded");
    remainingBytes -= bytes;
  }

  async function read(inputRequest: TaskEvidenceRequest, signal?: AbortSignal): Promise<TaskEvidence> {
    if (!inputRequest || !["file", "diff"].includes(inputRequest.kind)) throw new Error("Invalid evidence request");
    const request = { ...inputRequest };
    const fields = request.kind === "file" ? ["kind", "path", "startLine", "maxLines", "maxBytes"] : ["kind", "path", "maxBytes"];
    if (Object.keys(request).some((key) => !fields.includes(key))) throw new Error("Unsupported evidence request field");
    const parts = validatePath(request.path, workspace.protectedPaths);
    const maximum = limit(request.maxBytes, MAX_TEXT_BYTES, MAX_TEXT_BYTES);
    const startLine = request.kind === "file" ? limit(request.startLine, 1, 10_000) : 1;
    const maxLines = request.kind === "file" ? limit(request.maxLines, 500, 500) : 500;
    // Restrict diff header syntax so its exact path can be checked without interpreting quoted VCS output.
    if (request.kind === "diff" && !/^[\p{L}\p{N} _./-]+$/u.test(request.path)) throw new Error("Evidence diff path contains unsupported characters; use file evidence");
    if (outstanding >= 2 || requests >= 128) throw new Error("Evidence request limit exceeded");
    signal?.throwIfAborted();
    outstanding++;
    requests++;
    const observedAt = now().toISOString();
    try {
      const root = path.resolve(workspace.rootPath);
      if (await fs.realpath(root) !== root) throw new Error("Evidence workspace root must not traverse symlinks");
      const content = await readWorkspaceFile(root, parts, request.kind === "diff", consume, signal);
      let text: string;
      let truncated: boolean;
      const notes = ["Workspace may change concurrently; this is inspection evidence, not integration validation."];
      if (request.kind === "file") {
        const lines = content!.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const selected = lines.slice(startLine - 1, startLine - 1 + maxLines).join("");
        text = textPrefix(selected, maximum);
        truncated = startLine > 1 || startLine - 1 + maxLines < lines.length || text !== selected;
      } else {
        consume(maximum);
        const result = await runDiff(workspace, root, request.path, maximum, timeoutMs, options.spawn ?? spawn, signal);
        validateDiff(result.text, request.path);
        text = result.text;
        truncated = result.truncated;
        if (workspace.vcs === "jj") notes.push("jj --ignore-working-copy observes stored revisions only; unsnapshotted edits may require file evidence.");
        else notes.push("Git diff compares stored base and HEAD trees only; uncommitted and untracked edits require file evidence.");
      }
      signal?.throwIfAborted();
      const result: TaskEvidence = {
        runId: workspace.runId, taskId: workspace.taskId, attemptId: workspace.attemptId,
        kind: request.kind, path: request.path, text, observedAt, completedAt: now().toISOString(), truncated,
        concurrentChangesPossible: true, integrationValidation: false, notes,
      };
      while (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) {
        result.text = textPrefix(result.text, Math.floor(Buffer.byteLength(result.text) / 2));
        result.truncated = true;
      }
      return result;
    } finally {
      outstanding--;
    }
  }

  return { read };
}
