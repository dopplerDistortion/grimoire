// The Wiki screen (spec §20 Knowledge, Wiki; §17): read-only pages with their
// kind and sources (purged sources marked), 🔒 Quarantine and its lift, and a
// Log tab (human wiki edits and compiles, from `wiki_list`). A conflicted page
// shows every set-aside side as source text; a page a quarantined trace flags
// says so. Pages render as Markdown with raw HTML off; editing the wiki is
// CLI-only in v1 (`grimoire wiki edit <slug>`).
import { useState } from 'preact/hooks';
import { read } from './api';
import { ago, short } from './format';
import { useKnowledgeRead } from './knowledge';
import { Markdown } from './markdown';
import { liftQuarantineDialog, quarantineDialog } from './trace-actions';
import type { WikiListResult, WikiShowResult } from './types';
import { LockTag } from './ui';

export function WikiScreen({ slug }: { slug: string | null }) {
  const [tab, setTab] = useState<'pages' | 'log'>('pages');
  const list = useKnowledgeRead(() => read<WikiListResult>('wiki_list'));
  return (
    <div class="knowledge wiki">
      <h1>Wiki</h1>
      <p class="mute small">What the knowledge layer has learned. Agents working issues never see it; only knowledge chores read it.</p>
      <div class="row wiki-tabs">
        <button type="button" class={`qv tab-pages ${tab === 'pages' ? 'on' : ''}`} onClick={() => setTab('pages')}>
          Pages
        </button>
        <button type="button" class={`qv tab-log ${tab === 'log' ? 'on' : ''}`} onClick={() => setTab('log')}>
          Log
        </button>
      </div>
      {list.error ? <div class="banner bad">{list.error}</div> : null}
      <div class="grid2 wiki-grid">
        {tab === 'log' ? <WikiLog list={list.value} /> : <PageList list={list.value} current={slug} />}
        {slug ? <WikiPage key={slug} slug={slug} onChanged={list.reload} /> : <div class="panel pad mute">Pick a page.</div>}
      </div>
    </div>
  );
}

function PageList({ list, current }: { list: WikiListResult | null; current: string | null }) {
  if (!list) return <div class="panel pad mute">Loading…</div>;
  if (list.pages.length === 0) return <div class="panel pad mute">No pages yet: the Wiki Maintainer writes them from settled traces.</div>;
  return (
    <div class="panel page-list">
      {list.pages.map((page) => (
        <a key={page.slug} href={`/knowledge/wiki/${page.slug}`} class={`att wiki-page-row ${page.slug === current ? 'current' : ''}`} data-slug={page.slug}>
          <div class="grow">
            <b>{page.title}</b>
            <div class="small mute">
              {page.slug} · {page.kind} · {page.sources.length} source{page.sources.length === 1 ? '' : 's'} · updated {ago(page.updated_at)}
            </div>
          </div>
          {page.conflicted ? <span class="chip bad">conflicted</span> : null}
          {page.quarantined ? <span class="chip warn">quarantined</span> : null}
          {page.flagged_by.length > 0 ? <span class="chip warn">flagged</span> : null}
        </a>
      ))}
    </div>
  );
}

function WikiLog({ list }: { list: WikiListResult | null }) {
  if (!list) return <div class="panel pad mute">Loading…</div>;
  return (
    <div class="panel pad small wiki-log">
      {list.log.length === 0 ? <div class="mute">Nothing yet.</div> : null}
      {[...list.log].reverse().map((entry, k) => (
        <div key={k} class="log-entry">
          {ago(entry.at)} ·{' '}
          {entry.kind === 'compile' ? (
            <>
              Wiki Maintainer run <span class="id">{entry.run}</span> compiled {entry.traces} trace{entry.traces === 1 ? '' : 's'}
            </>
          ) : (
            <>
              {short(entry.by)} {entry.action === 'create' ? 'created' : 'updated'} (human wiki edit)
            </>
          )}
          {entry.pages.length > 0 ? ' into ' : ', writing no pages'}
          {entry.pages.map((slug, j) => (
            <span key={slug}>
              {j > 0 ? ', ' : ''}
              <a href={`/knowledge/wiki/${slug}`}>{slug}</a>
            </span>
          ))}
          {entry.resolved > 0 ? `, resolving ${entry.resolved} conflict${entry.resolved === 1 ? '' : 's'}` : ''}
        </div>
      ))}
    </div>
  );
}

function WikiPage({ slug, onChanged }: { slug: string; onChanged: () => Promise<void> }) {
  const { value: page, error, reload } = useKnowledgeRead(() => read<WikiShowResult>('wiki_show', { slug }), [slug]);
  if (!page) return <div class="panel pad mute">{error ?? 'Loading…'}</div>;
  const changed = async () => {
    await Promise.all([reload(), onChanged()]);
  };
  const purged = new Set(page.purged_sources);
  return (
    <div class="panel pad wiki-page">
      <div class="row between">
        <div>
          <div class="small mute">
            {page.kind} · knowledge/wiki/pages/{page.slug}.md{page.link ? ' · ' : ''}
            {page.link ? (
              <a href={page.link} target="_blank" rel="noreferrer noopener">
                on the forge
              </a>
            ) : null}
          </div>
          <h2 class="page-title">{page.title}</h2>
        </div>
        <div class="row">
          {page.quarantined ? (
            <button type="button" class="unquarantine-page" onClick={() => liftQuarantineDialog({ page: page.slug }, changed)}>
              Lift quarantine… 🔒
            </button>
          ) : (
            <button type="button" class="quarantine-page" onClick={() => quarantineDialog({ page: page.slug }, changed)}>
              Quarantine… 🔒
            </button>
          )}
          <LockTag />
        </div>
      </div>
      {page.quarantined ? <div class="banner warn">Quarantined: kept out of knowledge chores and skill-proposal evidence, unedited.</div> : null}
      {page.flagged_by.length > 0 ? (
        <div class="banner warn flagged-banner">
          Flagged: a compile that wrote this page consumed the quarantined trace{page.flagged_by.length === 1 ? '' : 's'}{' '}
          {page.flagged_by.map((trace, k) => (
            <span key={trace}>
              {k > 0 ? ', ' : ''}
              <a href={`/attempts/${trace}`} class="id">
                {trace}
              </a>
            </span>
          ))}
          . Quarantine the page too, or lift the trace’s quarantine.
        </div>
      ) : null}
      <p class="small summary">{page.summary}</p>
      <Markdown source={page.body} class="wiki-body" />
      {page.sides.length > 0 ? (
        <div class="sides">
          <div class="banner bad">Conflicted: a fold set {page.sides.length === 1 ? 'a side' : `${page.sides.length} sides`} aside. Reconcile with <code>grimoire wiki edit {page.slug}</code> in a terminal.</div>
          {page.sides.map((side) => (
            <div key={side.id} class="side">
              <div class="small mute">
                Set-aside side {side.id.slice(0, 10)} · {side.fields.join(', ')} · {ago(side.at)} · sources {side.sources.join(', ') || 'none'}
              </div>
              {side.body !== undefined ? <pre class="src side-body">{side.body}</pre> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div class="small sources">
        Sources:{' '}
        {page.sources.length === 0 ? 'none' : null}
        {page.sources.map((trace, k) => (
          <span key={trace}>
            {k > 0 ? ', ' : ''}
            {purged.has(trace) ? (
              <>
                <span class="id">{trace}</span> <span class="chip purged-source">purged</span>
              </>
            ) : (
              <a href={`/attempts/${trace}`} class="id">
                {trace}
              </a>
            )}
          </span>
        ))}
      </div>
      <div class="mute small">Read-only here: correct a page with `grimoire wiki edit {page.slug}`. The wiki is never rolled back.</div>
    </div>
  );
}
