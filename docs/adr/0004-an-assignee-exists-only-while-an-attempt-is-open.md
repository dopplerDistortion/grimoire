# An issue's assignee exists only while an attempt is open, and a claim refuses even its own person

An issue has an assignee exactly when it has an open attempt. The assignee is always a person, known by their git identity, and never an agent. Agents act on that person's behalf, and they show up as the client and session of the change's actor.

**Claiming.** A claim is a compare-and-set. It fails if anyone already holds the issue, including another session of the same person, and on success it returns a server-minted attempt handle.

**Ending an attempt.** Close and release must name that handle, and an agent can never end another person's attempt. Closing or releasing clears the assignee. Reopening is human-only and leaves the issue unassigned.

This departs from GitHub and Linear, where assigning is an unconditional set that survives closing. Grimoire keys outcomes and traces on attempts, so two things must never happen:
- a developer's parallel sessions silently sharing, or ending, each other's attempt;
- a leftover assignee keeping a reopened issue off the frontier.

## Considered Options

- **The assignee as an agent identity**, such as `claude-code` or `codex`. Rejected for two reasons:
  - "assign to me" would lose the meaning the skill pack relies on;
  - an agent session's identity doesn't last: clearing or forking a conversation starts a new one.
- **An unconditional assign, as in Linear and GitHub.** Rejected: two sessions of one developer can both "win" the same ticket. That happened on the map that planned grimoire.
- **Leases or heartbeats on claims.** Rejected for v1: agents can't send heartbeats reliably, and the server never sees a session end. A stale claim shows up through its last activity time, and it is recovered by an explicit release marked as abandoned.

## Consequences

- A crashed session's claim stays in place until someone releases it as abandoned, and that attempt's outcome is fail. This matches ADR 0001, which sets no inactivity timeout.
- Claims are exclusive only among writers on one machine. Across clones, conflicting claims are settled when the clones merge, so readers must cope with an issue that has two open attempts.
- An agent told that an issue is already claimed moves on to another issue, unless the user named that issue. Even then it continues only by explicitly taking over the existing attempt's handle.
