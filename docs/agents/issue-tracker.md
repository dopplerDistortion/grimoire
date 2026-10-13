# Issue tracker: Linear

This is the maintainer's agent workflow. The Linear workspace is private: outside contributors report bugs and ideas in [GitHub issues](https://github.com/dopplerDistortion/grimoire/issues) and send changes as pull requests (see [docs/contributing.md](../contributing.md)).

Issues and specs for this repo live in **Linear**, workspace `goksening`, team **Goksening** (key `GOK`), project **grimoire**. Use the Linear MCP tools (`mcp__claude_ai_Linear__*`) for all operations. Always pass `project: "grimoire"` and `team: "GOK"` when creating.

## Conventions

- **Create an issue**: `save_issue` with `team`, `project`, `title`, `description` (Markdown, real newlines).
- **Read an issue**: `get_issue` with the identifier (e.g. `GOK-112`); add `includeRelations: true` for blocking edges.
- **List issues**: `list_issues` with `project: "grimoire"` plus `label`, `state`, `parentId`, `assignee` filters.
- **Make an issue a sub-issue of a parent**: `save_issue` with `parentId: "<parent identifier>"`.
- **Comment on an issue**: `save_comment` with `issueId` and `body`.
- **Apply / remove labels**: `save_issue` with `addLabels` / `removeLabels` (never `labels`, which replaces the set).
- **Close**: `save_issue` with `state: "Done"` (or `"Canceled"` for out-of-scope).
- **Link an asset**: `save_issue` with `links: [{url, title}]`.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the grimoire project.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **sub-issues** as tickets.

- **Map**: a single issue labelled `wayfinder:map` in the grimoire project, holding Destination / Notes / Decisions-so-far / Not yet specified / Out of scope. Edit it with `save_issue` + `patch` (anchored inserts), never a full-description rewrite, since other sessions edit it concurrently.
- **Child ticket**: a sub-issue of the map (`parentId`). Labels: exactly one of `wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task`.
- **Blocking**: Linear's native **blocks / blocked by** relations (`save_issue` with `blockedBy` / `blocks`; append-only, remove with `removeBlockedBy`). A ticket is unblocked when every blocker is in a completed or canceled state.
- **Frontier query**: `list_issues` with `parentId: <map>`, open states only; drop any with an assignee, and any whose `get_issue(includeRelations)` shows an open blocker; lowest identifier wins.
- **Claim**: `save_issue` with `assignee: "me"`, the session's first write.
- **Resolve**: `save_comment` with the answer, then `save_issue` with `state: "Done"`, then append a context pointer (`- [<ticket title>](<url>): <gist>`) to the map's Decisions-so-far via `patch` `insert_before` the `## Not yet specified` heading. Do all three **before** merging your PR. Merging a branch named after the ticket makes Linear's GitHub integration close the ticket immediately, so the resolution comment would land after the close.
- **Research assets**: findings go to `docs/research/<name>.md` on a `research/<name>` branch, linked from the ticket, and merged to `main` through a PR like any other change (see below).

## Commits and pull requests

Every session that changes repo files finishes by committing, opening a PR, and merging that PR itself.

- **Where to work**: in your own git worktree, on the ticket's Linear `gitBranchName`, branched from `origin/main`. Never commit in the shared main checkout `D:\Dev\grimoire`, because other sessions read and write there.
- **Commit** only your own files. End the message with the `Co-Authored-By` attribution line.
- **Catch up before pushing**: run `git fetch origin && git merge origin/main`. Conflicts in `GLOSSARY.md` are routine. Keep both sides' terms, then reread the result to catch duplicates or contradictions. Never force-push.
- **Open the PR**: `gh` isn't installed, so call GitHub's REST API with git's stored credential and never print the token. Node lives at `C:\Program Files\nodejs` but isn't on PATH. In Git Bash:

  ```sh
  gh_api() { # gh_api METHOD /repos/dopplerDistortion/grimoire/... [json-file-in-cwd]
    local t; t=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
    curl -sS -X "$1" -H "Authorization: Bearer $t" -H "Accept: application/vnd.github+json" \
      "https://api.github.com$2" ${3:+--data-binary "@$3"}
  }
  gh_api POST /repos/dopplerDistortion/grimoire/pulls pr.json   # {"title","head","base":"main","body"}
  ```

  Write the body with the `pr` skill and end it with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line.
- **Order**: resolve the ticket on the tracker first (comment, Done, map pointer), then merge. Never open a PR on the **map's** branch name: merging it closes the map.
- **Merge it yourself**: `gh_api PUT /repos/dopplerDistortion/grimoire/pulls/<n>/merge merge.json` with `{"merge_method":"squash"}`. If the merge fails because of a conflict, catch up again, push, and retry.
- **Link it**: add the PR to the Linear ticket (`save_issue` with `links`), call the T3 tool `link_pull_request`, and put the PR URL and its merge result in your report.
