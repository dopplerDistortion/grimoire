# Grimoire

An issue tracker that agents talk to natively, installed into a repo and run entirely on the local machine, whose knowledge layer compiles the experience of working issues into an ever-evolving wiki and set of skills.

## Language

### Installation

**Host repo**:
A repository that grimoire has been installed into; each host repo has exactly one grimoire of its own, and issues never cross host repos.
_Avoid_: Target project, consumer project, workspace

**Dotfolder**:
The `.grimoire/` directory at the root of a host repo's checkout, holding grimoire's install configuration, its manifest, and the files agents and humans read straight from the checkout, such as evolved skills; issue state lives in the live store instead.
_Avoid_: Data dir, grimoire folder, store

**Live store**:
Grimoire's one working state for a host repo on one machine: the tracker branch plus never-committed machine-local data, both kept in the clone's git common directory so that every worktree reads and writes the same state.
_Avoid_: Database, cache, data dir, dotfolder

**Tracker branch**:
The git branch on which grimoire alone commits a host repo's issues, attempts, traces, outcomes and knowledge records; it is never checked out or merged into code, and clones exchange it by ordinary git fetch and push.
_Avoid_: Sync branch, data branch, issues branch, ledger

**Pointer file**:
A small file grimoire writes outside the dotfolder solely so an agent client can find grimoire, recorded in the dotfolder's manifest so it can be removed cleanly.
_Avoid_: Shim, integration file, config

**Agent client**:
A program that runs an AI agent's sessions on a developer's machine and through which the agent talks to grimoire, such as Claude Code or Codex.
_Avoid_: Harness, IDE, host, agent (for the program itself)

**Skill stub**:
A pointer file that makes one evolved skill visible to one agent client's own skill discovery, carrying the skill's name and description but not its text.
_Avoid_: Skill mirror, skill copy, skill shim

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

**Assignee**:
The person who holds an issue's open attempt: always a human, known by their git identity, even while an agent works the issue on their behalf; an issue with no open attempt has none.
_Avoid_: Owner, agent, worker

**Actor**:
Whoever made a change in grimoire: always a person, plus the agent client and session when an agent made it on that person's behalf, as observed by grimoire rather than claimed by the agent.
_Avoid_: Author, user, caller

**Session**:
One conversation an agent client runs, known by the client's own id for it; work a subagent does belongs to the session that launched it, and clearing or forking a conversation starts a new session.
_Avoid_: Thread, chat, conversation

### Knowledge

**Knowledge layer**:
The part of grimoire that turns the experience of working issues into a wiki and evolved skills, modelled on WikiSkill.
_Avoid_: Memory, brain, knowledge base

**Trace**:
The raw record of one attempt, sealed when the attempt ends and never edited after, complete in git without needing anything left on the machine where the work happened; it outlives edits to its issue and the issue itself.
_Avoid_: Log, trajectory, rollout, history

**Purge**:
A human's deliberate removal of a trace or a skill proposal from the live store, the only way either ever goes away.
_Avoid_: Delete, redact, prune

**Quarantine**:
A human's mark on a trace or pattern page that keeps it out of knowledge chores and out of a skill proposal's evidence, without purging it or rolling back the wiki.
_Avoid_: Ban, hide, suspend

**Transcript**:
An agent client's own full record of one session, kept by the client outside grimoire; grimoire reads transcripts but never stores them.
_Avoid_: Session file, rollout, conversation log

**Excerpt**:
The bounded, redacted step log of one session's work within an attempt, cut mechanically from its transcript and kept inside the trace.
_Avoid_: Summary, snippet, transcript

**Debrief**:
A worker's own short account of an attempt, posted on the issue as the attempt ends: what was tried, what failed, what worked, and what the next worker should know; agents are asked for one, humans may write one.
_Avoid_: Retro, summary, report, work log

**Outcome**:
The pass, fail, or none verdict on an attempt, held apart from its trace so it can be revised later, as when a reopen turns a pass into a fail or a human overrules it.
_Avoid_: Result, status, reward

**Wiki**:
The persistent, ever-growing body of markdown knowledge the knowledge layer compiles from past work; never rolled back.
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

**Runner**:
A per-machine opt-in that lets grimoire itself start an agent client's headless mode to do due knowledge chores unattended, on that person's own login.
_Avoid_: Worker, daemon, background agent, bot

**Skill**:
A procedure document an agent client loads in the host repo, whoever wrote it.
_Avoid_: Prompt, rule, instruction

**Evolved skill**:
A skill the knowledge layer owns and evolves from the wiki, kept in the dotfolder.
_Avoid_: Generated skill, grimoire skill, learned skill

**Eject**:
A human's move of an evolved skill out of the dotfolder into an agent client's own skill folder, after which it is an ordinary skill the knowledge layer never touches.
_Avoid_: Export, release, detach

**Skill proposal**:
One suggested change to exactly one evolved skill, creating it or patching it, drafted by the Skill Proposer together with its evidence; it never changes once written, and it changes nothing until a human accepts it.
_Avoid_: Suggestion, candidate, change request, PR

**Skill version**:
One exact text of an evolved skill, identified by that text alone, so the same words are always the same version.
_Avoid_: Revision, snapshot, release

**Restore**:
A human's forward change that makes an earlier skill version of an evolved skill current again, recorded as a new change rather than by undoing git history.
_Avoid_: Rollback, revert

**Skill ledger**:
The append-only record, written only by grimoire's own code, of every skill proposal, every decision on one, and every change to an evolved skill.
_Avoid_: Skill impact, changelog, audit log, history
