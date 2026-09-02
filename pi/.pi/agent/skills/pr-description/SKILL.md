---
name: pr-description
description: Generate and update a GitHub pull request description from its changes using the gh CLI. Use when given a GitHub PR number and asked to write or refresh the PR body/description.
allowed-tools: Bash, Read, Write
---

# PR Description

Update a GitHub pull request body with a concise description of the changes made.

## Input

The user must provide a GitHub PR number, for example:

```bash
/skill:pr-description 123
```

If no PR number is provided, ask the user for one before running commands.

## Workflow

1. Verify the GitHub CLI is available and authenticated:

   ```bash
   gh auth status
   ```

   If `gh` is unavailable or unauthenticated, stop and tell the user what needs to be fixed.

2. Identify the repository and fetch PR metadata:

   ```bash
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   gh pr view <PR_NUMBER> --repo "$REPO" --json number,title,body,baseRefName,headRefName,author,files,commits,additions,deletions,url
   ```

3. Inspect the PR changes using `gh`:

   ```bash
   gh pr diff <PR_NUMBER> --repo "$REPO" --stat
   gh pr diff <PR_NUMBER> --repo "$REPO"
   ```

   Focus on user-facing behavior, implementation changes, tests, configuration, migrations, and documentation. Do not include secrets or unrelated local changes.

4. Draft a PR body in this format unless the repository clearly uses a different template:

   ```markdown
   ## Summary
   - <high-level change>
   - <important implementation detail>

   ## Testing
   - <commands run, or "Not run (reason)">
   ```

   Keep it concise and specific. Mention notable risk, rollout notes, migrations, or follow-up work only when relevant.

5. Preserve useful existing PR body content when appropriate:
   - Keep unchecked checklist items, issue links, reviewer instructions, screenshots, and release notes if they are still relevant.
   - Remove stale generated text or placeholders.
   - If preserving sections, merge them cleanly with the generated Summary/Testing sections.

6. Write the final body to a temporary Markdown file and update the PR with `gh`:

   ```bash
   BODY_FILE=$(mktemp)
   cat > "$BODY_FILE" <<'EOF'
   ## Summary
   - ...

   ## Testing
   - ...
   EOF

   gh pr edit <PR_NUMBER> --repo "$REPO" --body-file "$BODY_FILE"
   rm -f "$BODY_FILE"
   ```

7. Confirm the update by showing the PR URL and a short summary of what was written.

## Notes

- Use only the `gh` CLI for GitHub data/actions.
- Do not use raw `git` commands unless the user explicitly asks.
- If the diff is too large, summarize by file list and commits first, then inspect the most relevant files/diff sections.
- If tests cannot be inferred from the PR, say `Not run (not provided)` rather than inventing test commands.
