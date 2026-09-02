---
name: workspace
description: Create a new jj (Jujutsu) workspace for a task and set up a bookmark branch. Use when starting a new task, feature, or bug fix that needs its own isolated workspace in a jj repo.
---

# Create JJ Workspace

Create a new jj workspace for the task and set up a branch.

## Task Description
$ARGUMENTS

## Instructions
1. Generate a short slug from the task description (lowercase, hyphens, no special chars, max 40 chars)
2. Create a new jj workspace using: `jj workspace add ../<repo-name>-<slug>`
3. Change into the new workspace directory
4. Create a bookmark (branch) named `hutch/<slug>` using: `jj bookmark create hutch/<slug>`
5. Confirm the setup by showing `jj status` and `jj bookmark list`

After setup, continue working on the task in the new workspace.
