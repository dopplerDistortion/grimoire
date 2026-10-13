// The Skills screens (spec §20 Knowledge, Skills; §18 The skill ledger,
// Restore, Delete, Eject, Forks), from the core's `skill_show`:
//
// - List: state, current version, version count, read rate, last change,
//   provenance, a "proposal pending" chip; blocked names with 🔒 Lift block.
// - Detail: the current text as source; the versions with 🔒 Restore, whose
//   dialog lists and diffs the versions the restore undoes and drops (the
//   plan comes from `skill_show {name, restore}`, and the restore names the
//   version it showed as current); per-version scorecards; the ledger; every
//   worktree's copy state; 🔒 Acknowledge (a fork's sides or a contested
//   decision's), 🔒 Eject (choosing a worktree; "commit and merge the ejected
//   files") and 🔒 Delete (the typed name). Delete and eject name the version
//   shown as their base, so a change made meanwhile is refused, never lost.
//
// Skill text and diffs render as source text, never markup.
import { useState } from 'preact/hooks';
import { read, write } from './api';
import { ago, short } from './format';
import { useKnowledgeRead } from './knowledge';
import { navigate } from './router';
import type { RestorePlan, Scorecard, ShownSkill, SkillShowResult } from './types';
import { errorText, LockTag, openDialog, SourceDiff, toast, Version } from './ui';

export function SkillsScreen({ name }: { name: string | null }) {
  return name === null ? <SkillList /> : <SkillDetail name={name} />;
}

/** The current version's read rate: reads of it against the attempts that were offered it. */
function readRate(skill: ShownSkill): string {
  const card = skill.scorecards.find((entry) => entry.version === skill.current);
  if (!card || card.offered === 0) return '—';
  return `${card.read} / ${card.offered}`;
}

function StateChips({ skill }: { skill: ShownSkill }) {
  const tone = skill.status === 'active' ? (skill.served === skill.current ? 'ok' : 'warn') : skill.status === 'none' ? '' : 'bad';
  return (
    <span class="chips">
      <span class={`chip skill-state ${tone}`}>{skill.status === 'active' && skill.served !== skill.current ? 'withheld' : skill.status}</span>
      {skill.superseded.length > 0 ? <span class="chip warn">fork</span> : null}
      {skill.contested.length > 0 ? <span class="chip bad">contested</span> : null}
      {skill.pending_proposal ? <span class="chip acc proposal-pending">proposal pending</span> : null}
      {skill.attention.map((flag) => (
        <span key={flag} class="chip warn attention-flag">
          {flag}
        </span>
      ))}
    </span>
  );
}

function SkillList() {
  const { value, error, reload } = useKnowledgeRead(() => read<SkillShowResult>('skill_show'));
  if (!value) return <p class="mute">{error ?? 'Loading…'}</p>;
  const listed = value.skills.filter((skill) => !skill.blocked);
  const blocked = value.skills.filter((skill) => skill.blocked);
  return (
    <div class="knowledge skills">
      <div class="row between">
        <h1>Evolved skills</h1>
        <span class="mute skills-summary">
          {value.active} of {value.cap} active{value.over_cap ? ' (over the cap)' : ''} · delivery {value.delivery}
        </span>
      </div>
      <p class="mute small">Read-only here: skill text is edited with `grimoire skill edit` in a terminal, and grimoire records the change. Hand-written skills outrank these.</p>
      {error ? <div class="banner bad">{error}</div> : null}
      <div class="panel">
        <table class="skill-table">
          <thead>
            <tr>
              <th>Skill</th>
              <th>State</th>
              <th>Current</th>
              <th>Versions</th>
              <th>Read rate</th>
              <th>Last change</th>
              <th>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {listed.length === 0 ? (
              <tr>
                <td colSpan={7} class="mute">
                  No evolved skills yet.
                </td>
              </tr>
            ) : null}
            {listed.map((skill) => (
              <tr key={skill.name} class="skill-row" data-skill={skill.name}>
                <td>
                  <a href={`/knowledge/skills/${encodeURIComponent(skill.name)}`}>
                    <b>{skill.name}</b>
                  </a>
                  {skill.description ? <div class="small mute">{skill.description}</div> : null}
                </td>
                <td>
                  <StateChips skill={skill} />
                </td>
                <td>
                  <Version id={skill.current} />
                </td>
                <td class="versions">{skill.versions}</td>
                <td class="read-rate">{readRate(skill)}</td>
                <td class="small mute">{skill.last_change ? `${skill.last_change.kind} · ${ago(skill.last_change.at)}` : ''}</td>
                <td class="small provenance">{skill.provenance ? `${skill.provenance.kind} by ${short(skill.provenance.by)} (${skill.provenance.origin})` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Blocked names</h3>
      <div class="panel pad small blocked-names">
        {blocked.length === 0 ? <span class="mute">None.</span> : null}
        {blocked.map((skill) => (
          <div key={skill.name} class="row between blocked-name">
            <span>
              <b>{skill.name}</b> · {skill.status}
              {skill.last_change ? ` by ${short(skill.last_change.by)} ${ago(skill.last_change.at)}` : ''}: no proposal may create it again
            </span>
            <button type="button" class="lift-block" onClick={() => liftBlock(skill.name, reload)}>
              Lift block… 🔒
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function liftBlock(name: string, reload: () => Promise<void>) {
  openDialog({
    title: `Lift the block on ${name}?`,
    humanOnly: true,
    ok: 'Lift block',
    body: <p>A Skill Proposer may propose a skill of this name again. Nothing is restored.</p>,
    run: async () => {
      await write('skill_unblock', { name });
      toast(`Lifted the block on ${name}.`);
      await reload();
    },
  });
}

function SkillDetail({ name }: { name: string }) {
  const { value, error, reload } = useKnowledgeRead(() => read<SkillShowResult>('skill_show', { name }), [name]);
  const skill = value?.skills[0];
  if (!skill) return <p class="mute">{error ?? 'Loading…'}</p>;
  const versions = versionsOf(skill);
  return (
    <div class="knowledge skill-detail">
      <div class="small">
        <a href="/knowledge/skills">Evolved skills</a> /
      </div>
      <div class="row between">
        <h1 class="mono">{skill.name}</h1>
        <div class="row skill-actions">
          {skill.acknowledge.length > 0 ? (
            <button type="button" class="pri acknowledge" onClick={() => acknowledgeDialog(skill.name, skill.acknowledge, skill.current, reload)}>
              Acknowledge… 🔒
            </button>
          ) : null}
          {skill.status === 'active' ? (
            <>
              <button type="button" class="eject" onClick={() => ejectDialog(skill, reload)}>
                Eject… 🔒
              </button>
              <button type="button" class="danger delete-skill" onClick={() => deleteDialog(skill)}>
                Delete… 🔒
              </button>
            </>
          ) : null}
          <LockTag />
        </div>
      </div>
      {error ? <div class="banner bad">{error}</div> : null}
      <StateChips skill={skill} />
      {skill.superseded.length > 0 ? (
        <div class="banner warn fork-banner">
          Two clones changed this skill apart. The ledger’s rules serve <Version id={skill.current} />; the other side (
          {skill.superseded.map((change, k) => (
            <span key={change.record}>
              {k > 0 ? ', ' : ''}
              <Version id={change.version} /> by {short(change.by)}
            </span>
          ))}
          ) is superseded until someone acknowledges one.
        </div>
      ) : null}
      {skill.contested.map((contest) => (
        <div key={contest.proposal} class="banner bad contested-banner">
          {contest.proposal} was accepted on one clone and rejected ({contest.rejected.join(', ')}) on another.
          {contest.withheld ? ' A suspicious reject withholds the accepted version everywhere until someone acknowledges.' : ''}
        </div>
      ))}
      <div class="small">
        current <Version id={skill.current} />
        {skill.served !== skill.current ? (
          <>
            {' '}
            · served <Version id={skill.served} />
          </>
        ) : null}
        {skill.provenance ? ` · ${skill.provenance.kind} by ${short(skill.provenance.by)} ${ago(skill.provenance.at)} (${skill.provenance.origin})` : ''}
      </div>
      {typeof skill.text === 'string' ? <pre class="src skill-text">{skill.text}</pre> : <p class="mute">No current text ({skill.status}).</p>}

      <h3>Versions</h3>
      <div class="panel versions-panel">
        {versions.map((entry) => (
          <div key={entry.version} class="att version-row" data-version={entry.version}>
            <div class="grow">
              <Version id={entry.version} /> {entry.version === skill.current ? <span class="chip acc">current</span> : null}
              {entry.fate ? <span class="chip warn">{entry.fate}</span> : null}
              <div class="small mute">
                {entry.kind} · {short(entry.by)} · {ago(entry.at)}
              </div>
            </div>
            {entry.version !== skill.current ? (
              <button type="button" class="restore" onClick={() => void restoreDialog(skill.name, entry.version, reload)}>
                Restore… 🔒
              </button>
            ) : null}
          </div>
        ))}
        {versions.length === 0 ? <div class="pad mute">No versions.</div> : null}
      </div>

      <h3>Scorecards (watch-only)</h3>
      <ScorecardTable cards={skill.scorecards} current={skill.current} />

      <h3>Skill ledger</h3>
      <div class="panel pad small ledger">
        {[...(skill.history ?? [])].reverse().map((record) => (
          <div key={record.record} class="ledger-row">
            {ago(record.at)} · {record.kind}
            {record.proposal ? ` (${record.proposal})` : ''} {record.from ? <Version id={record.from} /> : null}
            {record.version && record.version !== record.from ? (
              <>
                {' '}
                → <Version id={record.version} />
              </>
            ) : null}{' '}
            · {short(record.by)} <span class="mute">({record.origin})</span>
            {record.reason ? <span class="mute"> · {record.reason}</span> : null}
            {record.fate ? <span class="chip warn">{record.fate}</span> : null}
          </div>
        ))}
      </div>

      <h3>Copies in this clone’s worktrees</h3>
      <div class="panel">
        <table class="copy-states">
          <thead>
            <tr>
              <th>Worktree</th>
              <th>Copy</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {(skill.copies ?? []).map((copy) => (
              <tr key={copy.worktree} class="copy-row">
                <td class="small mono">{copy.worktree}</td>
                <td>
                  <Version id={copy.version} />
                </td>
                <td>
                  <span class={`chip ${copy.state === 'current' ? 'ok' : copy.state === 'behind' ? 'warn' : ''}`}>{copy.state}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface VersionEntry {
  version: string;
  kind: string;
  by: string;
  at: string;
  fate?: string;
}

/** Each version the ledger made current, newest first, with the record that last made it current. */
function versionsOf(skill: ShownSkill): VersionEntry[] {
  const latest = new Map<string, VersionEntry>();
  for (const record of skill.history ?? []) {
    if (record.version === null) continue;
    latest.set(record.version, { version: record.version, kind: record.kind, by: record.by, at: record.at, ...(record.fate ? { fate: record.fate } : {}) });
  }
  return [...latest.values()].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
}

export function ScorecardTable({ cards, current }: { cards: readonly Scorecard[]; current: string | null }) {
  if (cards.length === 0) return <p class="mute">No scorecards yet.</p>;
  return (
    <div class="panel">
      <table class="scorecards">
        <thead>
          <tr>
            <th>Version</th>
            <th>Offered</th>
            <th>Read</th>
            <th>Pass / fail / none (readers)</th>
            <th>Reopens</th>
            <th>Pattern recurrence</th>
            <th>Wiki-exposed · delivery off</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.version} class="scorecard">
              <td>
                <Version id={card.version} /> {card.version === current ? <span class="chip acc">current</span> : null}
              </td>
              <td>{card.offered}</td>
              <td>
                {card.read}
                {card.read_unknown > 0 ? <span class="mute"> (+{card.read_unknown} unknown)</span> : null}
              </td>
              <td>
                {card.pass} / {card.fail} / {card.none} {card.small_sample ? <span class="chip">small sample, n={card.n}</span> : null}
              </td>
              <td>{card.reopens}</td>
              <td>{card.recurrence === null ? '—' : card.recurrence}</td>
              <td class="small">
                {card.wiki_exposed.read} read · {card.delivery_off.offered} offered
              </td>
              <td>
                {card.attention.map((flag) => (
                  <span key={flag} class="chip warn">
                    {flag}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The versions to pick from, the standing one picked to begin with. */
function VersionChoices({ choices, standing }: { choices: readonly string[]; standing: string | null }) {
  const [picked, setPicked] = useState<string | null>(standing !== null && choices.includes(standing) ? standing : null);
  return (
    <div class="version-choices">
      {choices.map((version) => (
        <label key={version} class="row small">
          <input type="radio" name="version" value={version} checked={picked === version} onChange={() => setPicked(version)} />
          <Version id={version} /> {version === standing ? <span class="chip acc">standing now</span> : null}
        </label>
      ))}
    </div>
  );
}

export function acknowledgeDialog(name: string, choices: readonly string[], standing: string | null, reload: () => Promise<void> | void) {
  openDialog({
    title: `Acknowledge a version of ${name}`,
    humanOnly: true,
    ok: 'Acknowledge',
    body: (
      <>
        <p>The version you pick stands everywhere after sync; the others are superseded with no negative evidence.</p>
        <VersionChoices choices={choices} standing={standing} />
      </>
    ),
    validate: (values) => (values.version ? null : 'Pick the version that stands.'),
    run: async (values) => {
      await write('skill_acknowledge', { name, version: values.version });
      toast(`Acknowledged ${values.version!.slice(0, 10)} of ${name}.`);
      await reload();
    },
  });
}

async function restoreDialog(name: string, version: string, reload: () => Promise<void>): Promise<void> {
  let plan: RestorePlan;
  try {
    const shown = await read<SkillShowResult>('skill_show', { name, restore: version });
    if (!shown.restore) throw new Error('no restore plan');
    plan = shown.restore;
  } catch (error) {
    toast(errorText(error));
    return;
  }
  openDialog({
    title: `Restore ${name} to ${version.slice(0, 10)}?`,
    humanOnly: true,
    ok: 'Restore',
    body: (
      <div class="restore-plan">
        <p>
          Makes <Version id={plan.version} /> current again (now <Version id={plan.current} />). Agents get it on the next refresh.
        </p>
        {plan.lifts_block ? <p class="banner warn">{name} was deleted: restoring lifts its block and counts against the cap ({plan.active} of {plan.cap} active).</p> : null}
        {plan.undone ? (
          <div class="undone">
            <b>Undone</b> (counts as negative evidence): {plan.undone.kind} <Version id={plan.undone.version} /> by {short(plan.undone.by)} {ago(plan.undone.at)}
          </div>
        ) : null}
        <div class="dropped">
          <b>Dropped along the way</b> (not negative evidence; proposable again):{' '}
          {plan.dropped.length === 0 ? <span class="mute">none</span> : null}
          {plan.dropped.map((change) => (
            <div key={change.record} class="dropped-version">
              <div class="small">
                {change.kind} <Version id={change.version} /> by {short(change.by)} {ago(change.at)}
              </div>
              <SourceDiff lines={change.diff} context={2} />
            </div>
          ))}
        </div>
        <div class="small b">The current text against the restored one</div>
        <SourceDiff lines={plan.diff} context={2} />
      </div>
    ),
    run: async () => {
      await write('skill_restore', { name, version, base: plan.current });
      toast(`Restored ${name} to ${version.slice(0, 10)}.`);
      await reload();
    },
  });
}

function ejectDialog(skill: ShownSkill, reload: () => Promise<void>) {
  const worktrees = skill.worktrees ?? [];
  openDialog({
    title: `Eject ${skill.name}?`,
    humanOnly: true,
    ok: 'Eject',
    body: (
      <>
        <p>
          Writes the current text (<Version id={skill.current} />) as ordinary files into <code>.claude/skills/{skill.name}/</code> and <code>.agents/skills/{skill.name}/</code>{' '}
          of the worktree you pick, records the eject and blocks the name. From then on it is a hand-written skill grimoire never touches.
        </p>
        <label class="field">
          Worktree
          <select name="worktree">
            {worktrees.map((worktree) => (
              <option key={worktree} value={worktree}>
                {worktree}
              </option>
            ))}
          </select>
        </label>
        <p class="banner warn">Commit and merge the ejected files: until then only that worktree has them. An existing folder of that name is never overwritten.</p>
      </>
    ),
    validate: (values) => (values.worktree ? null : 'Pick a worktree.'),
    run: async (values) => {
      const result = await write<{ worktree: string; files: string[] }>('skill_eject', { name: skill.name, worktree: values.worktree, base: skill.current });
      toast(`Ejected ${skill.name} into ${result.worktree}: commit and merge ${result.files.join(' and ')}.`);
      await reload();
    },
  });
}

function deleteDialog(skill: ShownSkill) {
  openDialog({
    title: `Delete ${skill.name}?`,
    humanOnly: true,
    danger: true,
    ok: 'Delete skill',
    typed: skill.name,
    body: (
      <p>
        Stops serving it everywhere after sync and blocks the name, so no proposal creates it again until someone lifts the block. Its versions stay in the ledger:
        Restore brings one back.
      </p>
    ),
    run: async () => {
      await write('skill_delete', { name: skill.name, base: skill.current });
      toast(`Deleted ${skill.name}.`);
      navigate('/knowledge/skills');
    },
  });
}
