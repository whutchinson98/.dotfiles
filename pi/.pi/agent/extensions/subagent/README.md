# Subagent extension

Adds tools that let pi discover and spawn the markdown agents in `~/.pi/agent/agents`.

## Tools

- `agent_list` lists discovered agents.
- `subagent` runs one agent, parallel agents, or a sequential chain in isolated `pi --mode json --no-session` subprocesses. While it runs, pi opens a full-screen dashboard modeled after `davis7dotsh/my-pi-setup`, with one row per subagent and a scrollable live-output view for the selected agent.

Default scope is user agents only (`~/.pi/agent/agents`). Project agents from `.pi/agents` are opt-in with `agentScope: "project"` or `"both"`; interactive sessions ask for confirmation before running project-local agents.

Subagent subprocesses pass `--no-extensions` by default to avoid recursive agent tools and side effects from other extensions. Set `includeExtensions: true` when a delegated agent explicitly needs extension-provided tools.

An agent can include `ask_user` in its frontmatter tool allowlist to pause and surface a material question through the parent pi UI. The subagent extension injects only the isolated question bridge into that subprocess, sends a system notification when a question is ready, switches the live dashboard to an interactive question view, waits for the user's answer, and resumes the same agent run. Suggested answers can be selected directly, and `Write a different answer...` opens an inline text input for sending additional information to the agent. In parallel mode, questions are presented and announced one at a time. Non-interactive runs tell the agent to proceed with and document a safe assumption.

## Commands

- `/agents [user|project|both]` shows discovered agents in the UI.
- `/subagents` hides or restores the latest live subagent dashboard.

In the dashboard, use `j`/`k` or the arrow keys to select an agent, `Enter`/`l`/`Right` to open its output, `h`/`Left`/`Esc` to return, `g`/`G` to jump through output, and `q` to close it. When an agent asks a question, use `j`/`k` or the arrow keys to choose an answer and `Enter` to send it; choose `Write a different answer...` to type a custom response. `Esc` cancels the question or returns from custom input to the choices.

## Agent files

Agents are markdown files with frontmatter:

```markdown
---
name: planner
description: Architecture and implementation planning
tools: read,grep,find,ls,ask_user
model: claude-sonnet-4-5
---

System prompt for the delegated agent.
```

The existing agents live in `configs/pi/agent/agents` and are linked by Home Manager to `~/.pi/agent/agents`.
