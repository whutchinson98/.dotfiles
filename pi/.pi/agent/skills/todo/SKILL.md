---
name: todo
description: Read todo.md and implement all listed features. Use when asked to work through a todo list, implement planned features, or execute a batch of tasks from todo.md.
---

# Implement Todo

## Setup
1. Read `./.local/todo.md` — if it doesn't exist, stop and notify the user
2. Parse out all `Todo` items and identify which are parallelizable vs. sequential (e.g. tasks touching the same files should be sequential)

## Parallelization
- Spin up sub-agents for parallelizable tasks
- Flag any todos that touch overlapping files as sequential to avoid conflicts
- If a conflict arises during merge, stop and surface it to the user rather than guessing

## Per Todo Item
For each **parallelizable** `Todo`:
1. Use the `workspace` skill to create a new jj workspace and bookmark (`hutch/<slug>`)
2. Implement the feature carefully following the todo description
3. Run any relevant tests or checks before considering the item done
4. Mark the item as complete in `todo.md` (e.g. `- [x]`) and commit that change in the workspace

## Final Merge
Once all todos are complete:
1. Return to the main workspace
2. Merge all `hutch/<slug>` bookmarks into `hutch/<feature-name>` (derive the feature name from the overall theme of the todos)
3. Use `jj rebase` to linearize if needed, or note if manual conflict resolution is required
4. Show a summary: which todos succeeded, any that had issues, and the final bookmark name
