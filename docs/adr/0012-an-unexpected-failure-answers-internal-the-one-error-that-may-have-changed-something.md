# An unexpected failure answers `INTERNAL`, the one error that may have changed something

The spec's error table (§9) and ADR 0003 say an error means nothing changed. Every code in the table keeps that promise, because the core refuses before its single compare-and-set commit. A failure grimoire did not expect cannot keep it: a git spawn failure, a filesystem error or a defect can strike after the commit as easily as before it. So a surface answers such a failure with grimoire's `{error: {code, message, retryable, details}}` envelope, under one code outside the table, `INTERNAL`, with `retryable: false`. Its message tells the agent to re-read before retrying and to tell the user if it keeps happening.

## Considered Options

- **Let the MCP SDK answer the throw.** It turns a throwing `tools/call` handler into a JSON-RPC `-32603` that carries the raw message (spike B). Clients show that as a protocol failure, not a tool result, and the agent gets no instruction.
- **Reuse a code from the table.** Every one of them promises that nothing changed, and most name a cause with its own remedy. Borrowing one would send the agent into a blind retry or the wrong remedy.

## Consequences

- The §9 table gains a row: `INTERNAL`, an unexpected failure (a bug), no details, not retryable. "An error always means nothing changed" holds for every code except `INTERNAL`.
- An agent treats `INTERNAL` after a write as "maybe applied", and re-reads before it retries. A retry stays safe where the op replays: `create`, `comment` and `claim` on their `idempotency_key`, `close` and `release` on their own arguments.
- The CLI and the dashboard map an unexpected throw the same way, so all three surfaces agree on the code.
