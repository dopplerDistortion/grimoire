# Traces commit redacted session excerpts by default

The knowledge layer learns from traces, and a trace has to be complete in git, because git is grimoire's only sync layer and the Wiki Maintainer may run on any clone. The material that matters most, what the agent actually did step by step, lives in agent-client transcripts. Those are megabytes per session, use formats their vendors call internal, can hold secrets, and are deleted after 30 days by Claude Code's default. So each trace carries one excerpt per session that worked the attempt: cut mechanically (no LLM) from the transcript, capped at 15,000 characters (head, tail, and every failing step), scanned for secrets in-process before it is written, and committed inside `.grimoire/`. This is on by default, and one host-repo setting turns it off. Grimoire never stores raw transcripts, not even locally.

## Considered Options

- **No transcript material**: traces hold only the tracker record, the agent's debrief, and commit snapshots. Rejected because that leaves the Wiki Maintainer with only a biased self-report and none of the step-level evidence WikiSkill compiles from.
- **A local-only raw transcript store** (gitignored inside `.grimoire/`): rejected because it makes compiles depend on which machine runs them, and it duplicates the most sensitive data on disk.
- **LLM-written transcript summaries**: rejected because the debrief is already the agent's own account. The excerpt is its observed, deterministic counterpart, and it costs no tokens.

## Consequences

- Anything committed stays in git history. A purged trace leaves the dotfolder, but removing it from history needs a history rewrite, and other clones and forks keep their copies.
- Redaction is best-effort: secret scanners trade recall against false positives. GitHub push protection is the backstop for common token types. Personal data and proprietary tool output are not caught, which is why the off switch exists and `init` states plainly that excerpts will be committed.

_Amended by ADR 0007: traces are committed on the tracker branch, not in the checkout's `.grimoire/`. A purged trace leaves the tracker's tip, and history still keeps it._

_Amended by ADR 0008: a trace carries one excerpt per bound context, cut from the context that did the work, not one per session. The off switch is one setting with three values: `excerpts`, `facts` (skill reads and commits are recorded but no excerpt text) and `none`._

_Amended by the Runtime decision (GOK-117): `excerpts` is the default only when a human chooses it at `init`. Every `init`, including a join on another machine, shows this disclosure, and one that creates a tracker asks. An `init` that runs without a human answering seeds `facts`, unless `--excerpts` names the value explicitly. Each machine may also cap the mode lower for its own sessions._
