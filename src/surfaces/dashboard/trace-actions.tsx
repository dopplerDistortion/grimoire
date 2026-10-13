// The human-only actions on a trace and on a wiki page that more than one
// screen offers (spec §20 Attempt page, Knowledge, Confirmations): quarantine
// (a reason required) and its lift, and purge (the typed id and a reason; it
// says pushed history keeps it and lists what cites the trace). The attempt
// page, the Knowledge overview's set-aside pairs, Attention and the Wiki
// screen open the same dialogs.
import { read, write } from './api';
import type { AttemptShowResult } from './types';
import { errorText, openDialog, toast } from './ui';

type Reload = () => Promise<void> | void;

/** A quarantine target: a trace (its attempt handle) or a wiki page (its slug). */
export type QuarantineTarget = { trace: string } | { page: string };

const nameOf = (target: QuarantineTarget) => ('trace' in target ? `trace ${target.trace}` : `page ${target.page}`);

export function quarantineDialog(target: QuarantineTarget, reload: Reload) {
  openDialog({
    title: `Quarantine ${nameOf(target)}`,
    humanOnly: true,
    ok: 'Quarantine',
    body: (
      <>
        {'trace' in target ? (
          <p>Keeps this trace out of knowledge chores and out of any skill proposal’s evidence. Nothing is purged and the wiki is not rolled back.</p>
        ) : (
          <p>Keeps this page out of knowledge chores and out of any skill proposal’s evidence, without editing it.</p>
        )}
        <label class="field">
          Reason (required)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    validate: (values) => ((values.reason ?? '').trim() === '' ? 'Give a reason: a quarantine needs one.' : null),
    run: async (values) => {
      await write('quarantine', { ...target, reason: values.reason!.trim() });
      toast(`Quarantined ${nameOf(target)}.`);
      await reload();
    },
  });
}

export function liftQuarantineDialog(target: QuarantineTarget, reload: Reload) {
  openDialog({
    title: `Lift the quarantine on ${nameOf(target)}`,
    humanOnly: true,
    ok: 'Lift quarantine',
    body: (
      <>
        <p>{'trace' in target ? 'The trace counts as evidence again and is served to knowledge chores.' : 'The page is served to knowledge chores and counts as evidence again.'}</p>
        <label class="field">
          Reason (optional)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    run: async (values) => {
      await write('unquarantine', { ...target, ...((values.reason ?? '').trim() ? { reason: values.reason!.trim() } : {}) });
      toast(`Lifted the quarantine on ${nameOf(target)}.`);
      await reload();
    },
  });
}

/** What cites a trace, as the purge dialog lists it. */
export interface Citing {
  readonly pages: readonly { readonly slug: string }[];
  readonly proposals: readonly { readonly id: string }[];
}

export function purgeTraceDialog(attempt: string, citing: Citing, reload: Reload) {
  const { pages, proposals } = citing;
  openDialog({
    title: `Purge trace ${attempt}?`,
    humanOnly: true,
    danger: true,
    ok: 'Purge trace',
    typed: attempt,
    body: (
      <>
        <p>
          Removes the trace and its outcome from the tracker’s tip in one commit, and leaves a tombstone that wins every later fold. Unpushed tracker commits are
          rewritten without it.
        </p>
        <p class="banner warn purge-history">Pushed git history still keeps it: grimoire never rewrites pushed history, so the remote and every clone that fetched it keep the content.</p>
        {pages.length > 0 || proposals.length > 0 ? (
          <div class="banner warn purge-citing">
            Cited by {pages.length > 0 ? `pattern pages ${pages.map((page) => page.slug).join(', ')}` : ''}
            {pages.length > 0 && proposals.length > 0 ? ' and ' : ''}
            {proposals.length > 0 ? `proposals ${proposals.map((proposal) => proposal.id).join(', ')}` : ''}. They stay as written and show this source as purged.
          </div>
        ) : (
          <p class="mute small purge-citing">No pattern page or proposal cites it.</p>
        )}
        <label class="field">
          Reason (required, kept in the tombstone)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    validate: (values) => ((values.reason ?? '').trim() === '' ? 'Give a reason: a purge needs one.' : null),
    run: async (values) => {
      const result = await write<{ history: { note: string } }>('purge_trace', { attempt, reason: values.reason!.trim() });
      toast(`Purged ${attempt}. ${result.history.note}`);
      await reload();
    },
  });
}

/** Purge a trace from a screen that doesn't hold its attempt page: reads what cites it first. */
export async function purgeTraceByHandle(attempt: string, reload: Reload): Promise<void> {
  try {
    const shown = await read<AttemptShowResult>('attempt_show', { attempt });
    purgeTraceDialog(attempt, shown.knowledge, reload);
  } catch (error) {
    toast(errorText(error));
  }
}
