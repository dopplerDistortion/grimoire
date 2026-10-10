# Grimoire

An issue tracker that agents talk to natively, installed into a repo and run entirely on the local machine, whose knowledge layer compiles the experience of working issues into an ever-evolving wiki and set of skills.

## Language

### Installation

**Host repo**:
A repository that grimoire has been installed into; each host repo has exactly one grimoire of its own, and issues never cross host repos.
_Avoid_: Target project, consumer project, workspace

**Dotfolder**:
The `.grimoire/` directory at the root of a host repo, holding all of grimoire's state and configuration for that repo.
_Avoid_: Data dir, grimoire folder, store

**Pointer file**:
A small file grimoire writes outside the dotfolder solely so an agent client can find grimoire, recorded in the dotfolder's manifest so it can be removed cleanly.
_Avoid_: Shim, integration file, config

**Agent client**:
A program that runs an AI agent's sessions on a developer's machine and through which the agent talks to grimoire, such as Claude Code or Codex.
_Avoid_: Harness, IDE, host, agent (for the program itself)

### Tracking

**Issue**:
A unit of work tracked in a host repo's grimoire, worked by agents or humans.
_Avoid_: Ticket, task, card

**Attempt**:
One worker's run at one issue, agent or human, from claiming it (or closing it unclaimed) until it is closed, released, or reassigned; an issue has one or more attempts.
_Avoid_: Run, rollout, episode, session

**Assignee**:
The person an issue is assigned to: always a human, known by their git identity, even while an agent works the issue on their behalf.
_Avoid_: Owner, agent, worker

**Actor**:
Whoever made a change in grimoire: always a person, plus the agent client and session when an agent made it on that person's behalf, as observed by grimoire rather than claimed by the agent.
_Avoid_: Author, user, caller

### Knowledge

**Knowledge layer**:
The part of grimoire that turns the experience of working issues into a wiki and evolved skills, modelled on WikiSkill.
_Avoid_: Memory, brain, knowledge base

**Trace**:
The raw record of one attempt, written once when the attempt ends and never edited after, complete in git without needing anything left on the machine where the work happened; it outlives edits to its issue and the issue itself.
_Avoid_: Log, trajectory, rollout, history

**Purge**:
A human's deliberate removal of a trace from the dotfolder, the only way a trace ever goes away.
_Avoid_: Delete, redact, prune

**Transcript**:
An agent client's own full record of one session, kept by the client outside grimoire; grimoire reads transcripts but never stores them.
_Avoid_: Session file, rollout, conversation log

**Excerpt**:
The bounded, redacted step log of one session's work within an attempt, cut mechanically from its transcript and kept inside the trace.
_Avoid_: Summary, snippet, transcript

**Debrief**:
An agent's own short account of an attempt, posted on the issue as the attempt ends: what was tried, what failed, what worked, and what the next worker should know.
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

**Skill**:
A procedure document for agents working in the host repo, evolved by the knowledge layer from the wiki.
_Avoid_: Prompt, rule, instruction
