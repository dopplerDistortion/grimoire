// `doctor`'s store checks (spec §12 doctor, the store; §3, §4): unparsable
// or non-canonical records, duplicate ids, dangling references and cycles,
// conflicts and double open attempts, edits to write-once files, purged
// content still present, stale ref locks, sync ahead, behind or rejected,
// foreign commits and knowledge records without grimoire's trailers, and
// directory/file ref conflicts. What only the store can read (record bytes,
// history, refs) comes from the tracker store's checks; what reads see comes
// from the merged view and the core's derivations.
import { fieldConflict, findCycle, namedIn, openAttemptsOf, relatedIssue } from '../core/derive';
import { readSyncStatus } from '../core/sync';
import { aheadBehind, checkHistory, directoryFileConflicts, staleRefLocks, type StoreFinding, type TrackerRefTips, type TrackerView } from '../tracker';
import type { CheckOutcome, DoctorCheck, DoctorInput } from './doctor';
import { messageOf, type CheckFinding } from './health';


const NO_TRACKER = 'this clone has no grimoire tracker';
const REWRITE_REMEDY =
  'grimoire never rewrites a record it didn’t write that way: restore it from the tracker’s history (or the clone that has it right) through a grimoire op where one exists';

async function haveTracker(input: DoctorInput): Promise<boolean> {
  const tips = await input.tips();
  return tips.local !== null || tips.remotes.size > 0;
}

/** Runs `body` on the merged view, or says why there is none to check. */
async function withView(input: DoctorInput, body: (view: TrackerView) => Promise<CheckFinding[]> | CheckFinding[]): Promise<CheckOutcome> {
  if (!(await haveTracker(input))) return { skipped: NO_TRACKER };
  let view: TrackerView;
  try {
    view = await input.view();
  } catch (error) {
    return { skipped: `the merged view can’t be read: ${messageOf(error)}` };
  }
  return body(view);
}

const asFindings = (findings: readonly StoreFinding[], remedy?: string): CheckFinding[] =>
  findings.map((finding) => ({ ...finding, ...(remedy ? { remedy } : {}), ...(finding.details ? { details: { ...finding.details } } : {}) }));

const storeRecords: DoctorCheck = {
  name: 'store.records',
  section: 'store',
  async run(input) {
    if (!(await haveTracker(input))) return { skipped: NO_TRACKER };
    return asFindings((await input.trees()).records, REWRITE_REMEDY);
  },
};

const storeIds: DoctorCheck = {
  name: 'store.ids',
  section: 'store',
  run: (input) =>
    withView(input, (view) => {
      const sides = new Map<string, string[]>();
      for (const issue of view.issues()) {
        const tilde = issue.id.indexOf('~');
        if (tilde < 0) continue;
        const bare = issue.id.slice(0, tilde);
        sides.set(bare, [...(sides.get(bare) ?? []), issue.id]);
      }
      return [...sides]
        .filter(([bare, ids]) => ids.length > 1 && view.forwardOf(bare) === undefined)
        .map(([bare, ids]) => ({
          kind: 'duplicate-id',
          severity: 'warning' as const,
          subject: bare,
          message: `${bare} was minted on two clones; it stays ambiguous (${ids.join(', ')}) until a person picks the record that keeps it`,
          remedy: `grimoire resolve ${bare}`,
          details: { sides: ids },
        }));
    }),
};

const storeRelations: DoctorCheck = {
  name: 'store.relations',
  section: 'store',
  run: (input) =>
    withView(input, (view) => {
      const findings: CheckFinding[] = [];
      const issues = view.issues();
      for (const issue of issues) {
        const edges = [...(issue.parent !== null ? [['parent', issue.parent] as const] : []), ...issue.blocked_by.map((id) => ['blocked_by', id] as const)];
        for (const [field, target] of edges) {
          if (relatedIssue(view, target)) continue;
          const gone = view.deletion(target) ? 'which was deleted' : 'which no tracker here holds';
          findings.push({
            kind: 'dangling-reference',
            severity: 'warning',
            subject: issue.id,
            message: `${issue.id}'s ${field} names ${target}, ${gone}; it reads as unknown, and it blocks`,
            remedy: `grimoire update ${issue.id} to drop or replace ${target}`,
            details: { field, target },
          });
        }
      }
      const named = namedIn(view);
      const seen = new Set<string>();
      for (const issue of issues) {
        const cycle = findCycle(issues, issue.id, named);
        if (!cycle) continue;
        const members = [...new Set(cycle)].sort().join(' ');
        if (seen.has(members)) continue;
        seen.add(members);
        findings.push({
          kind: 'cycle',
          severity: 'warning',
          subject: issue.id,
          message: `these issues wait for each other, so none of them can be ready: ${cycle.join(' → ')}`,
          remedy: 'grimoire update one of them to break the cycle (a blocker or a parent)',
          details: { path: cycle },
        });
      }
      return findings;
    }),
};

const storeConflicts: DoctorCheck = {
  name: 'store.conflicts',
  section: 'store',
  run: (input) =>
    withView(input, async (view) => {
      const findings: CheckFinding[] = [];
      for (const issue of view.issues()) {
        const conflict = fieldConflict(view, issue.id);
        if (conflict) {
          findings.push({
            kind: 'conflict',
            severity: 'warning',
            subject: issue.id,
            message: `${issue.id} has a fold conflict on ${conflict.fields.join(', ')}: claims and writes to those fields wait until a person resolves it`,
            remedy: `a person picks whose value stands, in the dashboard or with grimoire resolve ${issue.id}`,
            details: { fields: conflict.fields },
          });
        }
        const open = openAttemptsOf(view, issue.id);
        if (open.length > 1) {
          findings.push({
            kind: 'double-open-attempts',
            severity: 'warning',
            subject: issue.id,
            message: `${issue.id} has ${open.length} open attempts (${open.map((a) => `${a.record.id} by ${a.assignee}`).join(', ')}), claimed on two clones`,
            remedy: 'the holders release or close theirs; a person can release another person’s with grimoire release --abandoned',
            details: { attempts: open.map((a) => a.record.id) },
          });
        }
      }
      for (const page of await view.wiki.pages()) {
        const sides = await view.wiki.conflicts(page.slug);
        if (sides.length === 0) continue;
        findings.push({
          kind: 'conflict',
          severity: 'warning',
          subject: `wiki:${page.slug}`,
          message: `the wiki page ${page.slug} has ${sides.length} set-aside side${sides.length === 1 ? '' : 's'} from a fold`,
          remedy: `a person merges it with grimoire wiki edit ${page.slug}`,
          details: { sides: sides.length },
        });
      }
      return findings;
    }),
};

const storeHistory: DoctorCheck = {
  name: 'store.history',
  section: 'store',
  async run(input) {
    if (!(await haveTracker(input))) return { skipped: NO_TRACKER };
    return asFindings(await checkHistory(input.root, await input.tips()));
  },
};

const storePurged: DoctorCheck = {
  name: 'store.purged',
  section: 'store',
  async run(input) {
    if (!(await haveTracker(input))) return { skipped: NO_TRACKER };
    return asFindings((await input.trees()).purged, 'run the purge again (grimoire purge trace|session|proposal), which removes what it left');
  },
};

const storeRefLocks: DoctorCheck = {
  name: 'store.ref-locks',
  section: 'store',
  async run({ dirs }) {
    return (await staleRefLocks(dirs.commonDir)).map((lock) => ({
      kind: 'stale-ref-lock',
      severity: 'error' as const,
      subject: lock.name,
      message: `${lock.name} is ${Math.round(lock.ageMs / 1000)} s old: a git that died left it, and tracker writes give BUSY until it goes`,
      fixable: true,
      details: { age_ms: lock.ageMs },
    }));
  },
};

/** The remote sync uses (spec §4, Remote choice): grimoire.remote, else one with a tracker, else origin. */
function syncRemote(tips: TrackerRefTips): string | null {
  if (tips.remotes.has('origin')) return 'origin';
  return [...tips.remotes.keys()][0] ?? null;
}

const storeSync: DoctorCheck = {
  name: 'store.sync',
  section: 'store',
  async run(input) {
    const findings: CheckFinding[] = [];
    const tips = await input.tips();
    if (tips.local !== null) {
      for (const [remote, tip] of tips.remotes) {
        const apart = await aheadBehind(input.root, tips.local, tip);
        if (!apart) continue;
        if (apart.ahead > 0) {
          findings.push({
            kind: 'sync-ahead',
            severity: 'info',
            subject: remote,
            message: `the local tracker has ${apart.ahead} commit${apart.ahead === 1 ? '' : 's'} ${remote} doesn’t have yet`,
            remedy: 'grimoire sync',
            details: { remote, ahead: apart.ahead, behind: apart.behind },
          });
        }
        if (apart.behind > 0) {
          findings.push({
            kind: 'sync-behind',
            severity: 'info',
            subject: remote,
            message: `${remote}’s tracker has ${apart.behind} commit${apart.behind === 1 ? '' : 's'} the local tracker doesn’t have yet (reads already show them)`,
            remedy: 'grimoire sync',
            details: { remote, ahead: apart.ahead, behind: apart.behind },
          });
        }
      }
    }
    const status = await readSyncStatus(input.dirs.commonDir, null);
    const failure = status.failure;
    if (failure) {
      const rejected = failure.class === 'rejected';
      findings.push({
        kind: rejected ? 'sync-rejected' : 'sync-failed',
        severity: rejected ? 'error' : 'warning',
        subject: status.remote ?? syncRemote(tips) ?? 'remote',
        message: `${status.summary}: ${failure.message}`,
        remedy: rejected
          ? 'the remote refuses grimoire/tracker: exempt it from branch rulesets, push protection and required checks, then run grimoire sync'
          : 'fix the remote’s access from this machine, then run grimoire sync',
        details: { class: failure.class, client: failure.client, surface: failure.surface, at: failure.at, remote: status.remote },
      });
    }
    return findings;
  },
};

/**
 * What a push's refusal says when the remote holds a ref named like a folder
 * of the tracker branch (`'refs/heads/grimoire' exists; cannot create …`,
 * `(refname conflict)`). Not git's bare `cannot lock ref`: a stale lock file
 * says that too (`Unable to create '….lock': File exists`), and is its own finding.
 */
const DF_REJECTION = /exists; cannot create|refname conflict|directory file conflict|blocking reference/i;

const storeRefNames: DoctorCheck = {
  name: 'store.ref-names',
  section: 'store',
  async run({ root, dirs }) {
    const findings: CheckFinding[] = (await directoryFileConflicts(root)).map((ref) => ({
      kind: 'df-ref-conflict',
      severity: 'error' as const,
      subject: ref,
      message: `the ref ${ref} blocks ${ref}/tracker: git can’t keep a ref and a folder of refs with one name`,
      remedy: `delete or rename ${ref} (git update-ref -d ${ref}), then run grimoire sync`,
    }));
    const failure = (await readSyncStatus(dirs.commonDir, null)).failure;
    if (failure && DF_REJECTION.test(failure.message)) {
      findings.push({
        kind: 'df-ref-conflict',
        severity: 'error',
        subject: 'remote',
        message: `the remote refused grimoire/tracker because a ref there is named like one of its folders: ${failure.message}`,
        remedy: 'delete or rename the remote branch named grimoire (or grimoire/tracker’s other prefix), then run grimoire sync',
      });
    }
    return findings;
  },
};

/** The store checks, in report order. */
export const STORE_CHECKS: readonly DoctorCheck[] = [
  storeRecords,
  storeIds,
  storeRelations,
  storeConflicts,
  storeHistory,
  storePurged,
  storeRefLocks,
  storeSync,
  storeRefNames,
];
