# Evolved skills serve only text a human accepted or wrote

WikiSkill accepts a Skill Proposer's change only when a validation score strictly improves. A host repo has no validation split and no ground truth, so grimoire's gate is a human.

A skill proposal is one atomic create or patch to one evolved skill. Grimoire's own code checks it mechanically first:
- validity and base version;
- size;
- enough cited failing traces, each one actually served to the chore;
- no repeat of a rejected change;
- hygiene and the secret scan.

The proposal then waits, and never expires into acceptance, until a human decides it in the dashboard or a human-only CLI command. No decision on a proposal is offered to agents. An agent's context holds the proposal's own untrusted text, which is the likeliest carrier of an injected "the user approves".

The same rule covers text that reaches an evolved skill without a proposal. If no human vouched for that text, grimoire withholds the skill's stubs until a human acknowledges it. Two cases trigger this: an agent's edit to an evolved skill, and a git merge of two accepts made separately from the same base. A change from an unknown actor is trusted like an edit to `CLAUDE.md`.

Outcome signals don't gate, for three reasons:
- **They can't be reproduced from committed data.** Outcomes are revisable, and traces on unmerged branches are invisible, so two clones would judge the same proposal differently.
- **They are underpowered.** Detecting a 10–20 point change in pass rate takes roughly 100–300 attempts per arm.
- **They are partly self-graded.** Agents working under the candidate skill produce them.

The paper's own gate rejected about 70% of proposals and still accepted a skill that lowered its model's score (OfficeQA, 30.2 → 28.5).

The skill ledger is append-only and written only by grimoire's code. It holds immutable proposals, skill versions identified by their text, and one record per decision or change. Nothing aggregated is committed, so the ledger merges under git without conflicts. Statuses, provenance (the paper's PURPOSE.md) and the paper's skill-impact view are all derived when read.

A bad change is undone by a **restore**: a new recorded change that makes an earlier whole version current again. A restore is never a `git revert`, because an accept commit can also carry wiki pages and records, and the wiki is never rolled back. It is never a history rewrite either.

Each decision records its actor and its basis. The basis is human review in v1, and `policy` is reserved, so automatic acceptance can be added later without changing the record. That leaves the human gate itself a two-way door. What is hard to reverse is everything around it:
- no agent path to accept;
- skill versions identified by their text and recorded in traces;
- the append-only ledger;
- forward-only restore.

## Considered Options

- **Accept on proxy signals** (reopen rate, pattern recurrence, attempts-to-close), or **probation with automatic revert.** Rejected for the three reasons above. Automatic revert would also let anyone who can make attempts fail remove a good skill.
- **Replay past failing traces against the candidate.** Rejected: there is no verifier, old environments can't be rebuilt from commit snapshots, and it would run possibly poisoned text in an agent with tools, unsandboxed on native Windows.
- **An LLM reviewer, accept on silence, or an opt-in autonomy setting.** Rejected. None of them has a quality signal, and self-judging systems (Dynamic Cheatsheet, ACE without labels, AWM) report degradation. Memory poisoning through queries alone has been demonstrated (MINJA).
- **Auto-accept patches and have a human review creates.** Rejected: a one-line `curl … | sh` patch is as dangerous as a create, and at the evolved-skill cap only patches remain.
- **Let agents accept on a human's chat instruction.** Rejected: an agent cannot prove the instruction came from the human. Agent interface (ADR 0003) also keeps human-only operations off MCP.
- **Accept by merging a git branch or PR as the primary gate**, as Devin does for skills. Rejected as the primary gate: it depends on hosting and on where knowledge writes land. Teams that review `.grimoire/` in PRs still get it as a second gate.
- **`git revert` or an inverse patch as undo.** Rejected: a `git revert` also reverts wiki pages and records, and an inverse patch serves a combination nobody reviewed.

## Consequences

- Evolution moves at the pace of review, with one pending proposal by default. A loop nobody reviews stalls visibly instead of degrading silently, so status surfaces must show what is waiting and why.
- A restore drops every later version built on the change it undoes. The human sees which versions before confirming, and dropped versions may be proposed again.
- Traces must record which skill *version* each attempt was offered at its start and read during it, plus the state of the delivery switch. This sharpens ADR 0002's "which evolved skills the attempt read", and it can't be backfilled once traces are written.
- The controls are procedural. A local agent with a shell can still forge records, so host-repo review of `.grimoire/` changes is the backstop.
