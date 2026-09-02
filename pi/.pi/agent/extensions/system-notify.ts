import { execFile, execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TITLE = "Pi";
const DEFAULT_MESSAGE = "Pi needs your attention";

function run(command: string, args: string[]): void {
	const child = execFile(command, args, { windowsHide: true }, () => {
		// Ignore notification failures (missing notify-send, disabled notifications, etc.).
	});

	child.unref?.();
}

function getTmuxSessionName(): string | undefined {
	if (!process.env.TMUX) return undefined;

	try {
		const name = execFileSync("tmux", ["display-message", "-p", "#S"], {
			encoding: "utf8",
			timeout: 1000,
		}).trim();
		return name || undefined;
	} catch {
		return undefined;
	}
}

function notificationMessage(message = DEFAULT_MESSAGE): string {
	const tmuxSession = getTmuxSessionName();
	return tmuxSession ? `${message} (tmux: ${tmuxSession})` : message;
}

export function notify(message = DEFAULT_MESSAGE, title = TITLE): void {
	const resolvedMessage = notificationMessage(message);

	if (process.env.IS_PI_REMOTE) {
		run("notification-proxy", [
			"send",
			"--endpoint",
			"http://olympus:50051",
			"--summary",
			resolvedMessage,
		]);
		return;
	}

	switch (process.platform) {
		case "darwin":
			run("osascript", [
				"-e",
				`display notification ${JSON.stringify(resolvedMessage)} with title ${JSON.stringify(title)}`,
			]);
			break;
		case "linux":
			run("notify-send", [title, resolvedMessage]);
			break;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		notify();
	});
}
