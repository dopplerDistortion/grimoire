# Dashboard v1 prototype (throwaway)

A rough, self-contained UI prototype for [Dashboard v1: what does the local dashboard show and let a human do?](https://linear.app/goksening/issue/GOK-118/dashboard-v1-what-does-the-local-dashboard-show-and-let-a-human-do). It is evidence for that decision, not a starting point for the build. The ticket's resolution comment holds the decisions.

## Run it

Open `index.html` in a browser. It needs no server, no build and no network, and all data lives in memory.

## What's on the page

The bottom bar is prototype chrome, not part of the design:

- **← / →** (or the arrow keys) switch the shell variant, also settable as `?variant=A|B|C|D`:
  - **A, Inbox.** Sidebar, the "needs you" queue as home, issue detail as a full page.
  - **B, Tracker.** Top tabs, the issue list as home, detail in a split pane, attention behind a bell.
  - **C, Board.** A board of derived states plus a knowledge rail as home, detail in a modal.
  - **D, Verdict (round 2), the default.** A's sidebar and attention home, B's split pane, C's board as a toggle, with the round-1 fixes.
- **Simulate…** fakes what the live-update stream would deliver: an agent claims an issue, an agent closes an issue and patches the map in one call, agents patch the map body (try it while editing the body), a fetch brings a double claim, a sync push is rejected, a proposal is drafted, the stream drops.
- **Screen state…** shows the full-page states: no dashboard session (what a bare `local_link` opens), `NOT_SYNCED` and `UPGRADE_REQUIRED`.

## Flows worth trying

- Edit the body of `gr-7k2pq`, then simulate "agent inserts on the map body" and save. Your edit is sent as anchored patches, so it merges.
- Edit the Destination line, then simulate "agent rewrites the map Destination" and save. Your edit collides, nothing is saved, and the conflict view shows both changes.
- Purge `at-b2c4d6` (open it from the proposal's cited traces), then review the proposal. Its evidence now falls below the minimum, which becomes a red flag that blocks Accept until acknowledged.
- Release the stale claim on `gr-v4n7c` as abandoned, reopen `gr-x9t3m`, override an outcome, or restore `webhook-retries` to an earlier version.
