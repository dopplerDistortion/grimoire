# Grimoire

An issue tracker that agents talk to natively, installed into a repo and run entirely on the local machine, whose knowledge layer compiles the experience of working issues into an ever-evolving wiki and set of skills.

## Language

### Installation

**Host repo**:
A repository that grimoire has been installed into; each host repo has exactly one grimoire of its own, and issues never cross host repos.
_Avoid_: Target project, consumer project, workspace

**Dotfolder**:
The `.grimoire/` directory at the root of a host repo's checkout, holding grimoire's install configuration, its manifest, and the generated copies of evolved skills that agents read straight from the checkout; issue state and the knowledge layer live in the live store instead.
_Avoid_: Data dir, grimoire folder, store

**Pinned version**:
The exact grimoire release a checkout of a host repo runs, committed in its dotfolder so that it travels with branches; every grimoire process started from that checkout runs exactly this release, and only an upgrade sets a new one.
_Avoid_: Installed version, current version, lock

**Join**:
A person's setup of grimoire on their own machine for one clone of a host repo and the pinned version its checkout names; it is needed before grimoire runs in that clone and again for each new pinned version, and it is the only step that downloads grimoire.
_Avoid_: Install, setup, onboarding

**Version copy**:
One grimoire release unpacked into a clone's git common directory and shared by every worktree of that clone; a join installs the copy its checkout pins, and agent clients only ever run grimoire from such a copy.
_Avoid_: Install, cache, vendored copy

**Launcher**:
The small machine-local program that every agent-client entry and the dotfolder's command-line runner go through, which runs the version copy a checkout pins once the clone has joined that version, and otherwise says how to join.
_Avoid_: Loader, wrapper

**Upgrade**:
A human's move of one checkout to a new pinned version, together with any change to the shape of grimoire's data that the new version needs; other branches take it through git like any change, and other machines through a join.
_Avoid_: Update, bump, migration

**Uninstall**:
A human's removal of grimoire from a host repo, made in one checkout and committed like any change; the tracker branch stays on the remote as an archive that a later install adopts again.
_Avoid_: Remove, purge, delete

**Leave**:
A person's removal of grimoire from one clone on their own machine, covering its downloaded copies, its machine-local data and the generated copies in every worktree, without changing the host repo or its tracker branch; the inverse of a join.
_Avoid_: Uninstall, unjoin, clean

**Live store**:
Grimoire's one working state for a host repo on one machine: the tracker branch plus never-committed machine-local data, both kept in the clone's git common directory so that every worktree reads and writes the same state.
_Avoid_: Database, cache, data dir, dotfolder

**Tracker branch**:
The git branch on which grimoire alone commits a host repo's issues, attempts, traces, outcomes and its whole knowledge layer, wiki and evolved-skill texts included; it is never checked out or merged into code, and clones exchange it by ordinary git fetch and push.
_Avoid_: Sync branch, data branch, issues branch, ledger

**Sync**:
Grimoire's exchange of the tracker branch with a clone's remote by plain git: fetch the remote's tracker branch, fold it into the local one, and push the result, so that teammates see it after an ordinary `git fetch`; it runs on its own after the writes that matter, never holding one up, and a person can always run it by hand.
_Avoid_: Replicate, upload, publish

**Sync-pending marker**:
A machine-local note that one local tip of the tracker branch still has to reach the remote, set before a sync tries and cleared only once the remote holds that tip or a later one, so that a sync that fails or dies is tried again.
_Avoid_: Dirty flag, outbox, queue

**Pointer file**:
A small file grimoire writes outside the dotfolder solely so an agent client can find grimoire, recorded in the dotfolder's manifest so it can be removed cleanly.
_Avoid_: Shim, integration file, config

**Content pointer file**:
A pointer file, or a marked block in one, that holds text grimoire ships and may change in any release, such as the instruction text or the issue-tracker adapter block; upkeep rewrites it when it drifts from the pinned version's text and asks the person to commit it, unlike the pointer files that carry entry commands or permission grants, which only an install or upgrade writes.
_Avoid_: Doc file, generated file

**Upkeep**:
Grimoire's own mechanical background work for a host repo on one machine, such as catching up on excerpts, syncing the tracker branch and refreshing pointer files and skill copies, done on the side by grimoire's own long-running processes rather than by any one command, and never by an LLM.
_Avoid_: Housekeeping, maintenance, background job, daemon

**Upkeep part**:
One kind of upkeep work, done either once for the whole clone or once for each worktree that pins the running version, which a process skips while another process is doing the same part and which runs at most so often across the clone.
_Avoid_: Task, job, step

**Agent client**:
A program that runs an AI agent's sessions on a developer's machine and through which the agent talks to grimoire, such as Claude Code or Codex.
_Avoid_: Harness, IDE, host, agent (for the program itself)

**Skill stub**:
A pointer file that makes one evolved skill visible to one agent client's own skill discovery, carrying the skill's name and description but not its text; grimoire generates it in each checkout, and nobody commits it.
_Avoid_: Skill mirror, skill copy, skill shim

**Generated output**:
The evolved-skill copies and skill stubs grimoire writes into every worktree that pins a release, byte for byte from what is served, each in a folder that ignores itself; it exists only where a pin is, nobody commits it, and a path git tracks is never written over.
_Avoid_: Generated files, build output, cache

**Served set**:
The evolved skills agents get in a clone right now, each at its served version, derived from the skill ledger in the merged tracker view and the delivery switch; each machine caches it, keyed by the tracker tip pair.
_Avoid_: Active skills, current skills, skill list

**SessionStart fast path**:
The SessionStart hook's own pass over its worktree's generated output: before the client lists skills, it writes whatever differs from the served set, under the worktree's lease, and never removes or moves anything.
_Avoid_: Hook reconcile, quick refresh

### Tracking

**Issue**:
A unit of work tracked in a host repo's grimoire, worked by agents or humans.
_Avoid_: Ticket, task, card

**Attempt**:
One worker's run at one issue, agent or human, from claiming it (or closing it unclaimed) until it is closed, released, or reassigned; an issue has one or more attempts.
_Avoid_: Run, rollout, episode, session

**Claim**:
Taking an open, unassigned issue to work it yourself, which opens an attempt; it fails if anyone already holds the issue, including another of your own sessions.
_Avoid_: Grab, pick up, self-assign

**Release**:
Giving up a claim without closing the issue, which ends the attempt as a fail.
_Avoid_: Unclaim, unassign, drop

**Stale claim**:
A claim whose open attempt has shown no activity for longer than a set time; because attempts never time out, it holds until a human releases it as abandoned.
_Avoid_: Expired claim, dead claim, zombie claim

**Assignee**:
The person who holds an issue's open attempt: always a human, known by their git identity, even while an agent works the issue on their behalf; an issue with no open attempt has none.
_Avoid_: Owner, agent, worker

**Actor**:
Whoever made a change in grimoire: always a person, plus the agent client, session and context when an agent made it on that person's behalf, as observed by grimoire rather than claimed by the agent.
_Avoid_: Author, user, caller

**Session**:
One top-level run of an agent client, known by the client's own id for it and made of one or more contexts; work a subagent does belongs to the session that launched it, and clearing or forking a session starts a new one.
_Avoid_: Thread, chat, conversation

**Context**:
The main line of a session, or one subagent inside it (in Codex, a subagent thread), each with its own transcript; a knowledge chore runs in one, and an excerpt is cut from one.
_Avoid_: Conversation, thread, agent

**Binding**:
The tie between an attempt and a context that claimed it, ended it, or wrote to its issue naming the attempt; only bound contexts have their transcripts cut into the attempt's trace, and every other write on the issue is recorded only as activity.
_Avoid_: Participation, membership, association

**Fold**:
Grimoire's own deterministic merge of a clone's tracker branch with the fetched one after they diverged, by rules that know each record's shape and never by `git merge`; a read shows it in memory, the next write commits it, and every clone reaches the same state whichever side folds.
_Avoid_: Sync, rebase, git merge

**Fold conflict**:
What a fold sets aside when two clones changed the same field of an issue, deleted an issue the other edited, or both claimed it: the issue keeps one value and shows the other beside it, and can't be claimed until a human resolves it. On a pattern page, two clones' overlapping edits leave the later page standing and the other side set aside beside it, with its own sources, until a later write reconciles them.
_Avoid_: Merge conflict, collision

### Surfaces

**Dashboard**:
The local web page a running grimoire serves to the person at the machine for one host repo; it shows the live store and, together with human-only CLI commands, is the only place a human-only operation can be done.
_Avoid_: UI, web app, admin panel, console

**Human-only operation**:
An operation grimoire never offers to agents, available only in the dashboard and in CLI commands that need an interactive terminal, such as reopening an issue, purging a trace or deciding a skill proposal.
_Avoid_: Admin action, privileged operation

### Knowledge

**Knowledge layer**:
The part of grimoire that turns the experience of working issues into a wiki and evolved skills, modelled on WikiSkill.
_Avoid_: Memory, brain, knowledge base

**Trace**:
The raw record of one attempt, sealed when the attempt ends and never edited after, complete in git without needing anything left on the machine where the work happened; it outlives edits to its issue and the issue itself.
_Avoid_: Log, trajectory, rollout, history

**Purge**:
A human's deliberate removal, from the live store, of a trace, a skill proposal, or one context's excerpt and facts still waiting on an open attempt; the only way a trace or a skill proposal ever goes away.
_Avoid_: Delete, redact, prune

**Quarantine**:
A human's mark on a trace or pattern page that keeps it out of knowledge chores and out of a skill proposal's evidence, without purging it or rolling back the wiki.
_Avoid_: Ban, hide, suspend

**Transcript**:
An agent client's own full record of one context of a session, kept by the client outside grimoire; grimoire reads transcripts but never stores them.
_Avoid_: Session file, rollout, conversation log

**Excerpt**:
The bounded, redacted step log of one bound context's work within an attempt, cut mechanically from its transcript, waiting with the attempt while it is open and then kept inside the trace.
_Avoid_: Summary, snippet, transcript

**Session record**:
One bound context's part of an attempt's trace: which client, session and context it was, the window grimoire cut from its transcript, its capture statuses and facts, and its excerpt when the excerpt mode allows one; it waits with the open attempt, a later cut replaces it only by reaching further, and the attempt's end freezes it.
_Avoid_: Capture file, session log, transcript

**Sweep**:
The upkeep part that catches capture up without waiting for a session to end: it cuts the bound contexts of open attempts that went idle or whose transcript was archived, and attaches their session records to the still-open attempt.
_Avoid_: Scan, crawl, harvest

**Late record**:
A session record that reaches an attempt through a fold after another clone ended it: admitted when it was cut before that end, dropped and counted when cut after it.
_Avoid_: Stray record, orphan record

**Observed commit**:
A commit a bound context was seen making: git's creation line in the result of its own commit, cherry-pick or revert command (or a subagent's it launched), or a creating entry in its worktree's HEAD reflog timed inside one of its tool calls; recorded in that context's session record, never inferred from hashes a log or show printed.
_Avoid_: Attempt commit, session commit, detected commit

**Referenced commit**:
A commit on any branch of the clone whose `Refs:` trailer names the issue, made while the attempt was open; recorded in the trace's `end.md` beside the observed commits of its session records.
_Avoid_: Linked commit, mentioned commit

**Agent skill edit**:
A commit that changes the generated evolved-skill copies (`.grimoire/skills/**`) made by an agent: an observed commit of an agent context, or a referenced commit carrying a known agent co-author trailer (marked agent-assisted in a human attempt); a merge counts only when a merged copy matches neither parent.
_Avoid_: Skill commit, stray commit

**Excerpt mode**:
The store setting (`excerpts`, `facts` or `none`) that decides what capture ever commits: excerpt text and facts, facts only, or nothing read from a transcript at all; a machine may only lower it for its own sessions.
_Avoid_: Capture level, privacy mode, trace mode

**Debrief**:
A worker's own short account of an attempt, posted on the issue as the attempt ends: what was tried, what failed, what worked, and what the next worker should know; agents are asked for one, humans may write one.
_Avoid_: Retro, summary, report, work log

**Outcome**:
The pass, fail, or none verdict on an attempt, held apart from its trace so it can be revised later, as when a reopen turns a pass into a fail or a human overrules it.
_Avoid_: Result, status, reward

**Wiki**:
The persistent, ever-growing body of markdown knowledge the knowledge layer compiles from past work, kept on the tracker branch rather than in any checkout; never rolled back, meaning that nothing done to a code branch can change it and grimoire changes it only by adding to its history.
_Avoid_: Knowledge base, notes, memory

**Pattern page**:
A wiki page describing one recurring failure mode or successful strategy, with its workaround.
_Avoid_: Lesson, insight, note

**Knowledge chore**:
A unit of knowledge-layer LLM work that grimoire offers, while it is due, to an agent already on the machine, whose result grimoire checks and writes itself; the only work in which an agent reads the wiki.
_Avoid_: Job, background task, maintenance run, queue item

**Wiki Maintainer**:
The knowledge chore that compiles a batch of traces into the wiki's pattern pages.
_Avoid_: Compiler, curator, summarizer

**Skill Proposer**:
The knowledge chore that drafts at most one skill proposal from the wiki, the traces it cites, and the skill ledger.
_Avoid_: Optimizer, skill writer, skill generator

**Chore run**:
One pickup of a due knowledge chore by one context, from its start until its result is accepted or it fails, is abandoned or expires; it records what grimoire served it and what it consumed.
_Avoid_: Job, lease, execution, invocation

**Chore carrier**:
A content pointer file, or the `chores` MCP prompt, that hands an agent client grimoire's one shipped chore procedure, so a due knowledge chore runs in an isolated context: the `grimoire-chores` skill and subagent in Claude Code, the `grimoire-chores` skill and role in Codex.
_Avoid_: Chore skill file, chore prompt template

**Runner**:
A per-machine opt-in that lets grimoire itself start an agent client's headless mode to do due knowledge chores unattended, on that person's own login.
_Avoid_: Worker, daemon, background agent, bot

**Skill**:
A procedure document an agent client loads in the host repo, whoever wrote it.
_Avoid_: Prompt, rule, instruction

**Evolved skill**:
A skill the knowledge layer owns and evolves from the wiki, whose text lives on the tracker branch and reaches each checkout as a generated copy in the dotfolder that nobody commits.
_Avoid_: Generated skill, grimoire skill, learned skill

**Eject**:
A human's move of an evolved skill out of grimoire into the agent clients' own skill folders, as ordinary files for the human to commit, after which it is an ordinary skill the knowledge layer never touches.
_Avoid_: Export, release, detach

**Stray edit**:
A change someone made to a checkout's generated copy of an evolved skill; grimoire sets it aside and puts the served text back, and it is served nowhere unless a human records it as a new skill version.
_Avoid_: Local edit, drift, observed change

**Skill proposal**:
One suggested change to exactly one evolved skill, creating it or patching it, drafted by the Skill Proposer together with its evidence; it never changes once written, and it changes nothing until a human accepts it.
_Avoid_: Suggestion, candidate, change request, PR

**Pending slot**:
The bound on skill proposals waiting for a human decision, one per host repo by default and judged on the merged view, so every worktree and clone shares it; while it is full the Skill Proposer isn't due and a proposal submit is refused.
_Avoid_: Queue, inbox, backlog

**Mechanical checks**:
The fail-closed rules grimoire's own code applies to a skill proposal before any human sees it (shape, names, base, size, the evidence minimum, repeats, copying, hygiene and the secret scan); a failure is a reason code, never a judgment of the advice.
_Avoid_: Validation, review, linting

**Risk flag**:
A fact grimoire computes about a skill proposal and shows its reviewer, such as where each command it adds comes from (its token origin), dangerous patterns or a near-rewrite; it never rejects a proposal by itself.
_Avoid_: Warning, score, lint

**Skill version**:
One exact text of an evolved skill, identified by that text alone, so the same words are always the same version.
_Avoid_: Revision, snapshot, release

**Restore**:
A human's forward change that makes an earlier skill version of an evolved skill current again, recorded as a new change rather than by undoing git history.
_Avoid_: Rollback, revert

**Skill ledger**:
The append-only record, written only by grimoire's own code, of every skill proposal, every decision on one, every change to an evolved skill, and every quarantine mark and clear.
_Avoid_: Skill impact, changelog, audit log, history

**Scorecard**:
The watch-only tally for one skill version, derived from the traces of agent attempts whose checkout offered it or that read it: how many were offered it, how many read it, the outcomes of those that read it, and the attempts whose facts were incomplete, counted as "read unknown"; never committed, and it changes nothing.
_Avoid_: Skill impact, metrics, rating
