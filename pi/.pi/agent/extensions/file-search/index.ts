import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

const EXEC_TIMEOUT_MS = 60_000;
const FD_DEFAULT_LIMIT = 1_000;
const FD_MAX_LIMIT = 10_000;
const FD_MAX_DEPTH_LIMIT = 64;
const RG_DEFAULT_COUNT_LIMIT = 100;
const RG_MAX_COUNT_LIMIT = 1_000;
const RG_MAX_CONTEXT = 20;
const PREVIEW_LINES = 20;

type ToolName = "fd" | "rg";
type FdEntryType = "file" | "directory" | "symlink";

const TOOL_COMMAND_NAMES: Record<ToolName, string[]> = {
  fd: ["fd", "fdfind"],
  rg: ["rg"],
};

interface FdToolParams {
  pattern?: string;
  path?: string;
  type?: FdEntryType;
  extension?: string;
  glob?: boolean;
  hidden?: boolean;
  max_depth?: number;
  limit?: number;
}

interface RgToolParams {
  pattern: string;
  path?: string;
  glob?: string;
  file_type?: string;
  case_sensitive?: boolean;
  fixed_strings?: boolean;
  hidden?: boolean;
  context?: number;
  limit?: number;
}

interface FormattedOutput {
  text: string;
  lineCount: number;
  truncated: boolean;
  fullOutputPath?: string;
}

const FD_TYPE_FLAGS: Record<FdEntryType, string> = {
  file: "f",
  directory: "d",
  symlink: "l",
};

const FD_TOOL_DESCRIPTION =
  "Find files and directories by name with fd. Respects .gitignore by default. Results are limited to 1000 entries unless a higher limit is given; output is limited to 2000 lines or 50KB, and complete truncated output is saved to a temporary file.";

const FD_PROMPT_SNIPPET = "Find files and directories by name with fd (fast, gitignore-aware).";

const FD_PROMPT_GUIDELINES = [
  "Use fd as the primary tool for discovering files and directories by name, extension, or glob instead of bash with find or ls -R.",
  "Use rg instead of fd when searching file contents rather than file names.",
  "Keep using bash for complex multi-step workflows that pipe or post-process file listings.",
];

const RG_TOOL_DESCRIPTION =
  "Search file contents with ripgrep. Uses smart-case matching, respects .gitignore by default, and returns at most 100 matches per file unless a different limit is given. Output is limited to 2000 lines or 50KB; complete truncated output is saved to a temporary file.";

const RG_PROMPT_SNIPPET = "Search file contents with ripgrep (fast regex content search).";

const RG_PROMPT_GUIDELINES = [
  "Use rg as the primary tool for searching file contents instead of bash with grep.",
  "Use fd instead of rg when looking for files by name rather than content.",
  "Set fixed_strings on rg when searching for literal code snippets containing regex metacharacters.",
  "Keep using bash for complex multi-step workflows that combine searching with other commands.",
];

function pathCandidates(tool: ToolName) {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const names = TOOL_COMMAND_NAMES[tool];

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }

  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      candidates.push(name);
    }
  }

  return candidates;
}

async function commandRuns(pi: ExtensionAPI, command: string) {
  try {
    const result = await pi.exec(command, ["--version"], { timeout: 5_000 });
    return commandExitCode(result) === 0;
  } catch {
    return false;
  }
}

function makeCommandResolver(pi: ExtensionAPI, tool: ToolName) {
  let resolved: string | undefined;

  return async () => {
    if (resolved) return resolved;

    for (const candidate of pathCandidates(tool)) {
      if (await commandRuns(pi, candidate)) {
        resolved = candidate;
        return resolved;
      }
    }

    throw new Error(`Could not find a working ${tool} executable. Rebuild Home Manager so Nix provides ${TOOL_COMMAND_NAMES[tool].join(" or ")}.`);
  };
}

function normalizeSearchPath(raw: string) {
  let path = raw.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function optionalPath(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const normalized = normalizeSearchPath(raw);
  return normalized === "" ? undefined : normalized;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function buildFdArgs(params: FdToolParams) {
  const args = ["--color=never"];
  if (params.hidden) args.push("--hidden");
  if (params.glob) args.push("--glob");
  if (params.type) args.push("--type", FD_TYPE_FLAGS[params.type]);
  if (params.extension) args.push("--extension", params.extension.replace(/^\.+/, ""));
  if (params.max_depth !== undefined) args.push("--max-depth", String(clamp(params.max_depth, 1, FD_MAX_DEPTH_LIMIT)));
  args.push("--max-results", String(clamp(params.limit ?? FD_DEFAULT_LIMIT, 1, FD_MAX_LIMIT)));
  args.push("--", params.pattern ?? "");

  const path = optionalPath(params.path);
  if (path) args.push(path);
  return args;
}

function buildRgArgs(params: RgToolParams) {
  const args = ["--line-number", "--color=never", "--no-heading", "--with-filename"];
  if (params.case_sensitive === true) args.push("--case-sensitive");
  else if (params.case_sensitive === false) args.push("--ignore-case");
  else args.push("--smart-case");
  if (params.fixed_strings) args.push("--fixed-strings");
  if (params.hidden) args.push("--hidden");
  if (params.context !== undefined) args.push("--context", String(clamp(params.context, 0, RG_MAX_CONTEXT)));
  if (params.glob) args.push("--glob", params.glob);
  if (params.file_type) args.push("--type", params.file_type);
  args.push("--max-count", String(clamp(params.limit ?? RG_DEFAULT_COUNT_LIMIT, 1, RG_MAX_COUNT_LIMIT)));
  args.push("--", params.pattern);

  const path = optionalPath(params.path);
  if (path) args.push(path);
  return args;
}

function outputLineCount(output: string) {
  const trimmed = output.replace(/\n+$/, "");
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

async function persistFullOutput(prefix: string, output: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, "output.txt");
  await writeFile(path, output, "utf8");
  return path;
}

async function formatOutput(output: string, tempPrefix: string): Promise<FormattedOutput> {
  const trimmed = output.replace(/\n+$/, "");
  const lineCount = outputLineCount(trimmed);
  const truncation = truncateHead(trimmed, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: trimmed, lineCount, truncated: false };
  }

  const fullOutputPath = await persistFullOutput(tempPrefix, trimmed);
  const text =
    `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full output saved to: ${fullOutputPath}]`;

  return { text, lineCount, truncated: true, fullOutputPath };
}

function commandExitCode(result: { code?: number; exitCode?: number }) {
  if (typeof result.code === "number") return result.code;
  if (typeof result.exitCode === "number") return result.exitCode;
  return 0;
}

function commandError(tool: string, result: { stderr?: string; stdout?: string; code?: number; exitCode?: number }) {
  const code = commandExitCode(result);
  const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${code}`;
  return `${tool} failed: ${detail}`;
}

function expandedPreview(result: { content: { type: string; text?: string }[] }, fullOutputPath: string | undefined, theme: ThemeLike) {
  let text = "";
  const content = result.content[0];
  if (content?.type === "text" && content.text) {
    const lines = content.text.split("\n");
    for (const line of lines.slice(0, PREVIEW_LINES)) text += `\n${theme.fg("dim", line)}`;
    if (lines.length > PREVIEW_LINES) text += `\n${theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines`)}`;
  }
  if (fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${fullOutputPath}`)}`;
  return text;
}

interface ThemeLike {
  fg(color: string, text: string): string;
}

function fdParameters() {
  return Type.Object({
    pattern: Type.Optional(Type.String({ description: "Regex matched against file names (or a glob when glob is true). Omit to list everything under path." })),
    path: Type.Optional(Type.String({ description: "Directory to search. Defaults to the current working directory." })),
    type: Type.Optional(
      StringEnum(["file", "directory", "symlink"] as const, {
        description: "Only return entries of this type: file, directory, or symlink.",
      }),
    ),
    extension: Type.Optional(Type.String({ description: "Only return files with this extension, e.g. 'ts' or 'md'." })),
    glob: Type.Optional(Type.Boolean({ description: "Treat pattern as a glob (e.g. '*.test.ts') instead of a regex." })),
    hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories. Defaults to false." })),
    max_depth: Type.Optional(
      Type.Integer({
        description: "Maximum directory depth to descend (1-64).",
        minimum: 1,
        maximum: FD_MAX_DEPTH_LIMIT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum number of results (1-10000). Defaults to 1000.",
        minimum: 1,
        maximum: FD_MAX_LIMIT,
      }),
    ),
  });
}

function rgParameters() {
  return Type.Object({
    pattern: Type.String({ description: "Regex to search for (literal text when fixed_strings is true)." }),
    path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to the current working directory." })),
    glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts' or 'src/**'." })),
    file_type: Type.Optional(Type.String({ description: "Only search files of this ripgrep type, e.g. 'ts', 'js', 'py', 'rust'." })),
    case_sensitive: Type.Optional(Type.Boolean({ description: "true forces case-sensitive matching, false forces case-insensitive. Defaults to smart-case." })),
    fixed_strings: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of a regex." })),
    hidden: Type.Optional(Type.Boolean({ description: "Search hidden files and directories. Defaults to false." })),
    context: Type.Optional(
      Type.Integer({
        description: "Lines of context to show around each match (0-20).",
        minimum: 0,
        maximum: RG_MAX_CONTEXT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum matches per file (1-1000). Defaults to 100.",
        minimum: 1,
        maximum: RG_MAX_COUNT_LIMIT,
      }),
    ),
  });
}

export default function fileSearch(pi: ExtensionAPI) {
  const resolveFd = makeCommandResolver(pi, "fd");
  const resolveRg = makeCommandResolver(pi, "rg");

  pi.registerTool({
    name: "fd",
    label: "Find Files",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: fdParameters(),

    async execute(_toolCallId, params, signal) {
      const command = await resolveFd();
      const result = await pi.exec(command, buildFdArgs(params as FdToolParams), { signal, timeout: EXEC_TIMEOUT_MS });
      const code = commandExitCode(result);
      if (code !== 0) throw new Error(commandError("fd", result));

      const formatted = await formatOutput(result.stdout, "pi-fd-");
      if (formatted.lineCount === 0) {
        return {
          content: [{ type: "text" as const, text: "No files found" }],
          details: { matchCount: 0, truncated: false },
        };
      }

      return {
        content: [{ type: "text" as const, text: formatted.text }],
        details: {
          matchCount: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      };
    },

    renderCall(args, theme) {
      const params = args as FdToolParams;
      let text = theme.fg("toolTitle", theme.bold("fd "));
      text += theme.fg("accent", params.pattern ? `"${params.pattern}"` : "(all)");
      if (params.path) text += theme.fg("muted", ` in ${params.path}`);
      const flags = [
        params.type && `type=${params.type}`,
        params.extension && `ext=${params.extension}`,
        params.glob && "glob",
        params.hidden && "hidden",
        params.max_depth !== undefined && `depth≤${params.max_depth}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details as { matchCount?: number; truncated?: boolean; fullOutputPath?: string } | undefined;
      if (!details || !details.matchCount) return new Text(theme.fg("dim", "No files found"), 0, 0);

      let text = theme.fg("success", `${details.matchCount} ${details.matchCount === 1 ? "entry" : "entries"}`);
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded) text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "rg",
    label: "Search Content",
    description: RG_TOOL_DESCRIPTION,
    promptSnippet: RG_PROMPT_SNIPPET,
    promptGuidelines: RG_PROMPT_GUIDELINES,
    parameters: rgParameters(),

    async execute(_toolCallId, params, signal) {
      const command = await resolveRg();
      const result = await pi.exec(command, buildRgArgs(params as RgToolParams), { signal, timeout: EXEC_TIMEOUT_MS });
      const code = commandExitCode(result);
      const noMatches = code === 1 && result.stdout.trim() === "";
      if (noMatches) {
        return {
          content: [{ type: "text" as const, text: "No matches found" }],
          details: { outputLines: 0, truncated: false },
        };
      }
      if (code !== 0) throw new Error(commandError("rg", result));

      const formatted = await formatOutput(result.stdout, "pi-rg-");
      return {
        content: [{ type: "text" as const, text: formatted.text }],
        details: {
          outputLines: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      };
    },

    renderCall(args, theme) {
      const params = args as RgToolParams;
      let text = theme.fg("toolTitle", theme.bold("rg "));
      text += theme.fg("accent", `"${params.pattern}"`);
      if (params.path) text += theme.fg("muted", ` in ${params.path}`);
      const flags = [
        params.glob && `glob=${params.glob}`,
        params.file_type && `type=${params.file_type}`,
        params.fixed_strings && "literal",
        params.hidden && "hidden",
        params.context !== undefined && `ctx=${params.context}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details as { outputLines?: number; truncated?: boolean; fullOutputPath?: string } | undefined;
      if (!details || !details.outputLines) return new Text(theme.fg("dim", "No matches found"), 0, 0);

      let text = theme.fg("success", `${details.outputLines} output ${details.outputLines === 1 ? "line" : "lines"}`);
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded) text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });
}
