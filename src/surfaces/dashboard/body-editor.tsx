// The body: rendered Markdown, and its editor (spec §20, Concurrent body
// edits). The editor keeps its draft, focus and scroll through live updates
// (the issue changes under it as props; this component's state and its
// textarea stay), and says "changed while you edit" with the incoming diff.
// Save sends anchored patches derived from diff(base, draft), anchored on the
// base, in one `update`. When they no longer apply (ANCHOR_NOT_FOUND or
// ANCHOR_AMBIGUOUS) nothing is saved, and the conflict view offers: redo my
// edit on the current text, replace the body with my draft (`if_revision`,
// confirmed, showing what it discards), or discard. A REVISION_CONFLICT on
// that replace re-reads and diffs again.
import { useState } from 'preact/hooks';
import { derivePatch, lineDiff } from '../../core/body-diff';
import { ApiError, write } from './api';
import { Markdown } from './markdown';
import type { IssueDetail } from './types';
import { DiffView, errorText, openDialog, toast } from './ui';

interface Edit {
  /** The body the draft started from, and its revision. */
  readonly base: string;
  readonly baseRevision: string;
  readonly draft: string;
  /** After "redo my edit": the draft that didn't apply, kept for copying. */
  readonly mine: string | null;
  /** The anchor error that stopped the last save, or null. */
  readonly conflict: string | null;
  /** Why the conflict view shows again (a replace met a newer revision). */
  readonly note: string | null;
  readonly showTheirs: boolean;
}

export function BodyBlock({ issue, reload }: { issue: IssueDetail; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<Edit>) => setEdit((current) => (current ? { ...current, ...patch } : current));

  if (!edit) {
    return (
      <section class="body-block">
        <div class="row between">
          <h3>Body</h3>
          <button
            type="button"
            class="link edit-body"
            onClick={() => {
              setError(null);
              setEdit({ base: issue.body, baseRevision: issue.revision, draft: issue.body, mine: null, conflict: null, note: null, showTheirs: false });
            }}
          >
            Edit body
          </button>
        </div>
        <div class="body">{issue.body.trim() === '' ? <p class="mute">No body.</p> : <Markdown source={issue.body} />}</div>
      </section>
    );
  }

  const theirs = issue.body !== edit.base ? lineDiff(edit.base, issue.body) : null;

  const save = async () => {
    const ops = derivePatch(edit.base, edit.draft);
    if (ops.length === 0) return setEdit(null);
    setBusy(true);
    setError(null);
    try {
      await write('update', { id: issue.id, body_patch: ops });
      setEdit(null);
      toast(`Saved ${issue.id} (${ops.length} anchored patch${ops.length === 1 ? '' : 'es'}).`);
      await reload();
    } catch (failure) {
      if (failure instanceof ApiError && (failure.code === 'ANCHOR_NOT_FOUND' || failure.code === 'ANCHOR_AMBIGUOUS')) {
        update({ conflict: failure.code, note: null });
        await reload();
      } else {
        setError(errorText(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  if (edit.conflict) {
    const replace = () => {
      const current = issue;
      const draft = edit.draft;
      openDialog({
        title: 'Replace the whole body with your draft?',
        danger: true,
        ok: 'Replace body',
        body: (
          <>
            <p>
              This sends the whole body with <code>if_revision {current.revision.slice(0, 12)}</code>, so it fails again if anything else changes first. It
              <b> discards</b> what the current body has that your draft doesn’t:
            </p>
            <DiffView lines={lineDiff(current.body, draft)} />
          </>
        ),
        run: async () => {
          try {
            await write('update', { id: current.id, body: draft, if_revision: current.revision });
          } catch (failure) {
            if (failure instanceof ApiError && failure.code === 'REVISION_CONFLICT') {
              update({ note: 'The body changed again before your replace landed, so nothing was saved. Here is the new diff.' });
              await reload();
              return;
            }
            throw failure;
          }
          setEdit(null);
          toast(`Replaced the body of ${current.id}.`);
          await reload();
        },
      });
    };
    return (
      <section class="body-block body-conflict">
        <h3>Body: your edit was not saved</h3>
        <div class="banner bad">
          Your change touches text that changed after you started (<code>{edit.conflict}</code>). Nothing was saved.
        </div>
        {edit.note ? <div class="banner warn">{edit.note}</div> : null}
        <div class="small b">Their change (since you started)</div>
        <DiffView lines={lineDiff(edit.base, issue.body)} context={2} />
        <div class="small b">Your change</div>
        <DiffView lines={lineDiff(edit.base, edit.draft)} context={2} />
        <div class="row wrap actions">
          <button
            type="button"
            class="pri redo"
            onClick={() => setEdit({ base: issue.body, baseRevision: issue.revision, draft: issue.body, mine: edit.draft, conflict: null, note: null, showTheirs: false })}
          >
            Redo my edit on the current text
          </button>
          <button type="button" class="danger replace" onClick={replace}>
            Replace the body with my draft…
          </button>
          <button type="button" class="discard" onClick={() => setEdit(null)}>
            Discard my draft
          </button>
        </div>
      </section>
    );
  }

  const ops = derivePatch(edit.base, edit.draft);
  return (
    <section class="body-block editing">
      <h3>Editing body</h3>
      {theirs ? (
        <div class="banner warn changed-while-editing">
          Changed while you edit. Saving sends your edit as anchored patches, so it merges unless it touches the same lines.{' '}
          <button type="button" class="link" onClick={() => update({ showTheirs: !edit.showTheirs })}>
            {edit.showTheirs ? 'Hide their change' : 'See their change'}
          </button>
        </div>
      ) : null}
      {theirs && edit.showTheirs ? <DiffView lines={theirs} context={2} /> : null}
      {edit.mine !== null ? (
        <>
          <div class="small b">Your earlier draft, for copying:</div>
          <pre class="src">{edit.mine}</pre>
        </>
      ) : null}
      <textarea class="body-editor" rows={16} value={edit.draft} onInput={(event) => update({ draft: event.currentTarget.value })} />
      <div class="small mute patch-preview">
        {ops.length === 0 ? 'No changes yet.' : `Will send ${ops.length} anchored patch${ops.length === 1 ? '' : 'es'} in one update.`}
      </div>
      {error ? <div class="err">{error}</div> : null}
      <div class="row actions">
        <button type="button" class="pri save-body" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button type="button" onClick={() => setEdit(null)}>
          Discard
        </button>
        <span class="mute small">Started from {edit.baseRevision.slice(0, 12)}</span>
      </div>
    </section>
  );
}
