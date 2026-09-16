---
name: macro-task
description: Work a Macro task end to end. Takes a Macro task id or macro.com task URL, reads the task through the Macro MCP, asks clarifying questions, implements it in the current repo, then commits, creates a jj bookmark, and pushes it to git.
argument-hint: <task-id or macro.com task URL>
disable-model-invocation: true
---

# Macro task

Take one Macro task from "assigned" to "pushed on a bookmark" in the repo you are
currently in. The task is: `$ARGUMENTS`

The flow is deliberately linear: resolve → read → inspect repo → clarify once →
implement → publish → report. The one interactive checkpoint is before any code
is written, because the end of this flow pushes to a shared remote and there is
no cheap undo after that.

## 1. Resolve the task id

Accept either a bare UUID or a URL such as `https://macro.com/app/task/<uuid>`
or `https://macro.com/app/md/<uuid>`. Extract the UUID.

If `$ARGUMENTS` is empty, list the user's open tasks and let them pick. Use
`ListEntities` with `includeTypes: ["document"]`, `df: {"l":{"dst":"task"}}`,
and a `propf` that ANDs "assigned to me" (`macro|<user email>`) with status
not Completed/Canceled. Offer the top few by title through `AskUserQuestion`
and stop if they pick none.

## 2. Read the task

Macro tasks are documents, so use the document tools with the task UUID:

- `ReadMetadata` for the title, project, and timestamps.
- `ReadContent` for the body. This is the spec.
- `GetEntityProperties` with `entity_type: "document"` for Status, Assignees,
  Priority, Due Date, Parent Task, and Subtasks.

Follow references that carry requirements: a parent task, linked documents,
or a design doc mentioned in the body. Read them with `ReadContent` too. Do not
wander into unrelated documents; the goal is the acceptance criteria, not a
tour of the workspace.

If the task is not something that gets done in a code repo (a doc to write, a
meeting to schedule), say so and stop. This skill is for repo work.

## 3. Inspect the repo

Everything happens in the current working directory, which must be a jj repo
(colocated with git is the norm here). Run:

```bash
jj root
jj git fetch
jj status
jj log -r 'trunk()..@' --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"'
```

Start new work from trunk so the bookmark contains only this task:
`jj new trunk()` when `@` is empty and already on trunk is a no-op, so run it
regardless. If `@` or its ancestors above trunk hold unrelated uncommitted work,
do not silently build on top of it or discard it; raise it in the clarifying
round (build on it, or start clean from trunk and leave that work where it is).

Read `CLAUDE.md`, `AGENTS.md`, or equivalent if present so the implementation
follows the repo's own conventions, test commands, and lint rules.

## 4. Clarify, once

Write a two-to-four sentence restatement of what the task asks for and how you
plan to do it. Then ask exactly one round of questions with `AskUserQuestion`
(up to four questions in the call):

- The first question is always the plan check: "Proceed with this plan?" with
  the restatement in the question text and the proposed bookmark name shown.
  Options: proceed, or adjust.
- Add a question for each genuine ambiguity: which of two interpretations,
  which repo or package if the task names one that is not the cwd, unclear
  acceptance criteria, unrelated in-progress work found in step 3.

Ask things that change what you build. Do not ask about things you can settle
by reading the code or the repo's conventions, and do not ask for permission
for routine steps. One round is the budget; if the answers open a genuinely
new fork, ask again, otherwise proceed.

### Bookmark name

Propose `whutchinson98/<slug>` where `<slug>` is the task title in lowercase
kebab-case, cut at a word boundary to about 50 characters. This matches the
existing branches in the work repos and the `auto-track-bookmarks` glob in the
jj config, so the pushed bookmark is tracked without extra steps. Example:

```
Title:    Setup AI routines to use Kafka
Bookmark: whutchinson98/setup-ai-routines-to-use-kafka
```

Use the name the user confirms in step 4.

## 5. Mark the task in progress

After the plan is confirmed, set Status to In Progress so the board reflects
reality while you work:

`SetEntityProperty` with `entity_type: "document"`, `entity_id: <task uuid>`,
`property_definition_id: 00000001-0000-0000-0000-000000000002`,
`option_id: 00000001-0000-0000-0002-000000000002`.

If this call fails, note it and continue; the status is a courtesy, not a gate.

## 6. Implement

Do the work the task describes, scoped to the task. Resist adjacent cleanups;
they belong in their own task and make review harder. Run the repo's tests
and linters for the code you touched. If something in the task turns out to be
impossible or clearly wrong, finish everything else and say plainly what you
left out and why, rather than reinterpreting the task to fit.

## 7. Publish

Write the commit message to a file in the scratchpad directory (a file avoids
shell-quoting a multi-line message). Match the repo's existing style; the work
repos use conventional commits, so the first line looks like
`feat(scope): short summary`. Then a blank line, a few lines on what changed
and why, and finally a line linking back to the task:

```
feat(routines): route routine triggers through kafka

Replace the polling loop with a kafka consumer on the routines topic so
triggers fire within a second instead of on the next poll tick.

Macro task: https://macro.com/app/task/<uuid>
```

Then run the bundled script, which commits `@`, creates the bookmark on that
commit, and pushes it. It refuses to run when `@` has no changes or the
bookmark already exists, so a stale or empty push cannot happen by accident:

```bash
"${CLAUDE_SKILL_DIR}/scripts/publish.sh" <bookmark> <message-file>
```

Pass a third argument to push to a remote other than `origin`.

If the push is rejected (remote moved, bookmark conflict), run `jj git fetch`,
`jj rebase -d trunk()`, resolve anything that comes up, and push again with
`jj git push --bookmark <bookmark>`. Do not use `--force`-style options; jj's
push is already lease-checked.

## 8. Close out

Set Status to In Review (`option_id: 00000001-0000-0000-0002-000000000003`)
with the same `SetEntityProperty` shape as step 5. The work is pushed but not
merged, so In Review is the honest state; do not mark it Completed.

Report to the user:

- The bookmark name, the commit's first line, and the remote it went to.
- What changed, in a few bullets, and anything left out and why.
- The test or lint commands that ran and their result.
- The task link as `https://macro.com/app/task/<uuid>`.

Opening a pull request is out of scope for this skill; mention it as the
natural next step if the repo uses PRs.
