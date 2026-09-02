import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const baseLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const maxEffortLevels = [...baseLevels, "max"] as const;

type BaseLevel = (typeof baseLevels)[number];
type EffortLevel = (typeof maxEffortLevels)[number];

const maxEffortModelPatterns = [/gpt[-_. ]?5\.5/i, /fable/i];
const effortStateEvent = "pi:effort-state";

let requestedEffortOverride: "max" | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function modelSupportsMaxEffort(model: unknown): boolean {
  if (!isRecord(model)) return false;

  const id = typeof model.id === "string" ? model.id : "";
  const name = typeof model.name === "string" ? model.name : "";
  const haystack = `${id} ${name}`;

  return maxEffortModelPatterns.some((pattern) => pattern.test(haystack));
}

function baseLevelsForModel(model: unknown): readonly BaseLevel[] {
  if (!isRecord(model)) return baseLevels;
  if (model.reasoning === false) return ["off"];

  const thinkingLevelMap = isRecord(model.thinkingLevelMap)
    ? model.thinkingLevelMap
    : undefined;

  const levels = baseLevels.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });

  return levels.length > 0 ? levels : ["off"];
}

function levelsForModel(model: unknown): readonly EffortLevel[] {
  const levels = baseLevelsForModel(model);

  if (
    isRecord(model) &&
    model.reasoning === true &&
    modelSupportsMaxEffort(model)
  ) {
    return [...levels, "max"];
  }

  return levels;
}

function isEffortLevel(value: string): value is EffortLevel {
  return (maxEffortLevels as readonly string[]).includes(value);
}

function highestPiLevelForMax(model: unknown): BaseLevel {
  const levels = baseLevelsForModel(model);
  return levels[levels.length - 1] ?? "off";
}

function toPiLevel(level: EffortLevel, model: unknown): BaseLevel {
  return level === "max" ? highestPiLevelForMax(model) : level;
}

function effectiveEffort(current: string, model: unknown): EffortLevel | string {
  if (
    requestedEffortOverride === "max" &&
    current === highestPiLevelForMax(model) &&
    modelSupportsMaxEffort(model)
  ) {
    return "max";
  }

  return current;
}

function nextLevel(current: string, model: unknown): EffortLevel {
  const levels = levelsForModel(model);
  const effectiveCurrent = effectiveEffort(current, model);
  const index = levels.indexOf(effectiveCurrent as EffortLevel);
  return levels[(index + 1) % levels.length];
}

function applyMaxEffortOverride(payload: unknown, piLevel: BaseLevel): boolean {
  if (!isRecord(payload)) return false;

  let changed = false;

  if (payload.reasoning_effort === piLevel) {
    payload.reasoning_effort = "max";
    changed = true;
  }

  const reasoning = payload.reasoning;
  if (isRecord(reasoning) && reasoning.effort === piLevel) {
    reasoning.effort = "max";
    changed = true;
  }

  const outputConfig = payload.output_config;
  if (isRecord(outputConfig) && outputConfig.effort === piLevel) {
    outputConfig.effort = "max";
    changed = true;
  }

  const additionalFields = payload.additionalModelRequestFields;
  if (isRecord(additionalFields)) {
    const additionalOutputConfig = additionalFields.output_config;
    if (
      isRecord(additionalOutputConfig) &&
      additionalOutputConfig.effort === piLevel
    ) {
      additionalOutputConfig.effort = "max";
      changed = true;
    }
  }

  return changed;
}

export default function (pi: ExtensionAPI) {
  function emitEffortState(model: unknown): string {
    const effort = String(effectiveEffort(pi.getThinkingLevel(), model));
    pi.events.emit(effortStateEvent, { effort, thinkingLevel: pi.getThinkingLevel() });
    return effort;
  }

  function setEffort(level: EffortLevel, model: unknown): string {
    requestedEffortOverride = level === "max" ? "max" : undefined;
    pi.setThinkingLevel(toPiLevel(level, model));
    return emitEffortState(model);
  }

  pi.registerCommand("effort", {
    description: "Set thinking effort: off|minimal|low|medium|high|xhigh|max",
    handler: async (args, ctx) => {
      const level = args.trim();
      const levels = levelsForModel(ctx.model);

      if (!isEffortLevel(level) || !levels.includes(level)) {
        ctx.ui.notify(
          `Usage: /effort ${levels.join("|")}. Current: ${effectiveEffort(
            pi.getThinkingLevel(),
            ctx.model,
          )}`,
          "warning",
        );
        return;
      }

      const effort = setEffort(level, ctx.model);
      ctx.ui.notify(`Thinking effort set to ${effort}`, "success");
    },
  });

  pi.registerCommand("effort-cycle", {
    description: "Cycle thinking effort",
    handler: async (_args, ctx) => {
      const next = nextLevel(pi.getThinkingLevel(), ctx.model);
      const effort = setEffort(next, ctx.model);
      ctx.ui.notify(`Thinking effort set to ${effort}`, "success");
    },
  });

  pi.registerShortcut("ctrl+e", {
    description: "Cycle thinking effort",
    handler: async (ctx) => {
      const next = nextLevel(pi.getThinkingLevel(), ctx.model);
      const effort = setEffort(next, ctx.model);
      ctx.ui.notify(`Thinking effort set to ${effort}`, "success");
    },
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (
      requestedEffortOverride === "max" &&
      event.level === highestPiLevelForMax(ctx.model) &&
      modelSupportsMaxEffort(ctx.model)
    ) {
      emitEffortState(ctx.model);
      return;
    }

    requestedEffortOverride = undefined;
    emitEffortState(ctx.model);
  });

  pi.on("model_select", async (event) => {
    if (!modelSupportsMaxEffort(event.model)) {
      requestedEffortOverride = undefined;
    }

    emitEffortState(event.model);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (
      requestedEffortOverride !== "max" ||
      !modelSupportsMaxEffort(ctx.model)
    ) {
      return;
    }

    const piLevel = highestPiLevelForMax(ctx.model);
    if (pi.getThinkingLevel() !== piLevel) {
      return;
    }

    if (applyMaxEffortOverride(event.payload, piLevel)) {
      return event.payload;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.prompt.includes("#deep")) {
      requestedEffortOverride = undefined;
      pi.setThinkingLevel("high");
      emitEffortState(ctx.model);
      ctx.ui.notify("Using high thinking for this prompt", "info");
    }

    if (event.prompt.includes("#quick")) {
      requestedEffortOverride = undefined;
      pi.setThinkingLevel("minimal");
      emitEffortState(ctx.model);
      ctx.ui.notify("Using minimal thinking for this prompt", "info");
    }
  });
}
