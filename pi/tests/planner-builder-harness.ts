import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
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
    spawn, fs, os, path, detectVcs, GitBackend, parsePlanTaskResultMarker,
    process: { ...process, env: { ...process.env, PI_PLAN_WORKSPACE_ROOT: workspaceRoot } },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    Type: new Proxy({}, { get: () => () => ({}) }), StringEnum: () => ({}),
    truncateHead: (content: string) => ({ content, truncated: false }),
    truncateTail: (content: string) => ({ content, truncated: false }),
    formatSize: String, USER_QUESTION_TOOL_NAME: "ask_user",
    sendSystemNotification: () => {},
    discoverAgents: () => ({ agents: [{ name: "builder" }, { name: "verifier" }, { name: "planner" }] }),
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
    setRunAgent(fn) { runAgent = fn; }
  })`, context);
}
