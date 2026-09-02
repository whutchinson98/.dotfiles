export type PlanTaskResultMarker = "done" | "failed" | "blocked";

export function parsePlanTaskResultMarker(output: string): PlanTaskResultMarker | undefined {
  let marker: PlanTaskResultMarker | undefined;
  let fence: "```" | "~~~" | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const fenceMatch = line.match(/^(```|~~~)/);
    if (fenceMatch) {
      const delimiter = fenceMatch[1] as "```" | "~~~";
      if (!fence) fence = delimiter;
      else if (fence === delimiter) fence = undefined;
      continue;
    }
    if (fence) continue;

    const match = line.match(/^PLAN_TASK_RESULT:\s*(done|failed|blocked)$/i);
    if (match) marker = match[1]?.toLowerCase() as PlanTaskResultMarker;
  }

  return marker;
}
