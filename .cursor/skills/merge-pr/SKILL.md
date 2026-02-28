---
name: merge-pr
description: Merge an upstream pull request into this fork by fetching the PR commits, creating a feature branch, pushing it to origin, and opening a PR. Use when the user asks to merge, incorporate, or pull in a PR using a GitHub PR number or URL.
---

# Merge Upstream PR into Fork

Cleanly incorporate a PR from the upstream repo (`delorenj/mcp-server-trello`) into this fork (`UserGeneratedLLC/mcp-server-trello`) while preserving original commits and authorship.

## Input Formats

The user may provide:
- A PR number: `#56`, `56`
- A GitHub URL: `https://github.com/delorenj/mcp-server-trello/pull/56`

Extract the PR number from whichever format is given.

## Workflow

### 1. Preflight Checks

```bash
git status              # Must be clean working tree
git remote -v           # Verify "upstream" points to delorenj/mcp-server-trello
git branch              # Note current branch
```

If `upstream` remote is missing:
```bash
git remote add upstream git@github.com:delorenj/mcp-server-trello.git
```

### 2. Gather PR Info

```bash
gh pr view <NUMBER> --repo delorenj/mcp-server-trello --json title,headRefName,baseRefName,commits,state
```

Confirm the PR is `OPEN` (or note if merged/closed). Extract the branch name and commit list.

### 3. Fetch PR into Local Branch

```bash
git fetch upstream pull/<NUMBER>/head:<branch-name>
```

Use the PR's `headRefName` as `<branch-name>` (e.g. `feat/download-attachment`).

### 4. Verify Commits

```bash
git checkout <branch-name>
git log --oneline main..<branch-name>
```

Confirm the expected commits are present.

### 5. Push to Origin

```bash
git push -u origin <branch-name>
```

### 6. Create PR on the Fork

Write the PR body to a temp file (PowerShell does not support heredocs), then create the PR:

```bash
gh pr create --repo UserGeneratedLLC/mcp-server-trello --base main --head <branch-name> --title "<PR title>" --body-file <temp-file>
```

**PR body template:**
```
## Summary

Incorporates upstream PR [delorenj/mcp-server-trello#<NUMBER>](https://github.com/delorenj/mcp-server-trello/pull/<NUMBER>).

### Changes

- <bullet summary of each changed file>

### Original Authors

- <list PR authors and co-authors>
```

Delete the temp file after PR creation.

### 7. Cleanup

```bash
git checkout main
```

Return the PR URL to the user.

## Shell Notes

- This repo runs in **PowerShell** on Windows. Do not use `&&` to chain commands or `<<'EOF'` heredocs.
- Use `;` to chain commands, or run them separately.
- For multi-line strings, write to a temp file and reference it with `--body-file`.

## Error Handling

| Problem | Resolution |
|---------|------------|
| Dirty working tree | Ask the user to stash or commit first |
| Branch name already exists locally | Delete it (`git branch -D <name>`) and re-fetch, or use a suffixed name |
| PR is already merged upstream | Inform the user; they may still want the commits in their fork |
| Merge conflicts | Report the conflicts and let the user decide how to resolve |
