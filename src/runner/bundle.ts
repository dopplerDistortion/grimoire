// What a runner child reads (spec §16 Spawn: "the served bundle on stdin"):
// the run's brief and everything grimoire serves it, gathered through the
// same `chore_read` an in-session chore pages, so every item is recorded on
// the run. A child has no tools, so the items an in-session chore would ask
// for (pages, trace parts, hand-written texts) come up front, within a size
// budget. The bundle opens with a fixed plain-text line: one that started
// with `/` would run as a slash command, and the model would never run
// (spike D, C3).
import type { ChoreBrief, ChoreReadResult } from '../core';
import type { ServedItem } from '../knowledge/chores';
import type { RunnerKind } from './config';

export const BUNDLE_HEADER = 'grimoire chore bundle: one grimoire maintenance chore to do, unattended; answer with the result object.';

/** The most characters of served items a bundle carries before it stops adding the on-request ones. */
export const BUNDLE_BUDGET = 600_000;

/** The runner's procedure: the child's appended system prompt (Claude), or the bundle's preamble (Codex). */
export const PROCEDURE = `You are grimoire's chore runner. You do one grimoire maintenance chore, unattended, with no tools.

The user message is grimoire's served bundle: the chore, everything grimoire serves it, and the shape of the result.

1. Read the whole bundle.
2. Reason about the served items. Base the result only on them, and cite only their ids.
3. Answer with exactly one result object in the shape of the result's JSON schema. That object is the only thing grimoire reads.
4. If the bundle ends with the reason codes of an earlier answer grimoire refused, fix exactly those and answer again with the whole result.

Never ask for approval or clarification, and never try to edit files or run commands: nobody is there to answer, and nothing can run.

Wiki Maintainer: put every batch pair in the consumption map, each to one or more page slugs, or to no_pattern with a short reason. Write a page only for a pattern that recurs across traces: create {slug, title, kind failure or strategy, summary of at most 200 characters, body}, or update {slug, base_hash you were served, body}. At most 8 page writes; each page at most 12,000 characters; an update shrinks a page by at most 25%. Never put a secret, a token or a credential in a page.

Skill Proposer: propose at most one evolved skill, or answer no_action when the evidence shows nothing worth proposing. Write host-repo facts and procedures (commands, conventions, pitfalls, where things live), never model-specific workarounds. Put the trigger words first in the description of at most 300 characters. Keep the body self-contained: never refer to pattern pages or the wiki. Cite the served pages and traces the proposal rests on.
`;

const KIND_NAMES: Readonly<Record<string, string>> = { 'wiki-maintainer': 'Wiki Maintainer', 'skill-proposer': 'Skill Proposer' };

/** Reads one `chore_read` page of the run: the manifest without `item`, or one item. */
export type PageReader = (input: { item?: string; cursor?: string }) => Promise<ChoreReadResult | null>;

/** Every page of a read, joined back into whole items (a long item is cut across pages at its `text`). */
async function readAll(read: PageReader, item?: string): Promise<ServedItem[] | null> {
  const items: ServedItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10_000; i++) {
    const page = await read({ ...(item !== undefined ? { item } : {}), ...(cursor !== undefined ? { cursor } : {}) });
    if (page === null) return null;
    for (const served of page.items) {
      const last = items.at(-1);
      const { offset, continues: _continues, ...rest } = served as ServedItem & { offset?: number; continues?: boolean };
      if (last && last.item === served.item && typeof offset === 'number' && offset > 0) {
        items[items.length - 1] = { ...last, text: `${last.text ?? ''}${served.text ?? ''}` };
      } else items.push(rest as ServedItem);
    }
    if (!page.cursor) return items;
    cursor = page.cursor;
  }
  return items;
}

function renderItem(item: ServedItem): string {
  const { item: id, kind, text, ...fields } = item;
  const lines = [`## ${id} (${kind})`];
  if (Object.keys(fields).length > 0) lines.push(JSON.stringify(fields));
  if (text !== undefined && text !== '') lines.push('', text);
  return lines.join('\n');
}

export interface Served {
  readonly items: ServedItem[];
  /** On-request items left out for the budget. */
  readonly left: number;
}

/**
 * Reads everything the run is served: its manifest, then the items an
 * in-session chore would ask for (each trace's parts, the hand-written texts
 * and `extraItems`: the wiki's pages), while the budget lasts.
 */
export async function gatherServed(read: PageReader, extraItems: readonly string[]): Promise<Served> {
  const items = (await readAll(read)) ?? [];
  const seen = new Set(items.map((item) => item.item));
  const wanted: string[] = [];
  for (const item of items) {
    if (item.kind === 'trace' && Array.isArray(item.parts)) wanted.push(...(item.parts as string[]));
    if (item.kind === 'handwritten' && typeof item.text === 'string') wanted.push(...item.text.split('\n').filter((line) => line.startsWith('handwritten:')));
  }
  wanted.push(...extraItems);
  let size = items.reduce((total, item) => total + JSON.stringify(item).length, 0);
  let left = 0;
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (size >= BUNDLE_BUDGET) {
      left++;
      continue;
    }
    const more = await readAll(read, id);
    if (more === null) continue;
    for (const item of more) {
      size += JSON.stringify(item).length;
      seen.add(item.item);
      items.push(item);
    }
  }
  return { items, left };
}

/** A refused answer's reason codes and problems, for the fix-up respawn. */
export interface Refusal {
  readonly reasons: readonly string[];
  readonly problems?: Readonly<Record<string, string>>;
}

/** The bundle a child reads on stdin. */
export function composeBundle(kind: RunnerKind, brief: ChoreBrief, served: Served, refusal: Refusal | null): string {
  const parts = [BUNDLE_HEADER, ''];
  if (kind === 'codex') parts.push('# How to do it', '', PROCEDURE.trim(), '');
  parts.push('# The chore', '', `${KIND_NAMES[brief.kind] ?? brief.kind}, run ${brief.run}.`, `Why it is due: ${brief.why}`);
  if (brief.pairs.length > 0) {
    parts.push('', 'The batch: every pair goes into the consumption map.');
    for (const pair of brief.pairs) parts.push(`- ${pair.pair} (trace ${pair.trace}, outcome ${pair.outcome})`);
  }
  if (brief.conflicted.length > 0) parts.push('', `Conflicted pages to reconcile (every side is served): ${brief.conflicted.join(', ')}`);
  parts.push('', '# The result', '', 'Answer with one JSON object in this shape:', '', JSON.stringify(brief.output_schema), '', '# Served items', '');
  for (const item of served.items) parts.push(renderItem(item), '');
  if (served.left > 0) parts.push(`(${served.left} more items weren't included: the bundle is at its size budget.)`, '');
  if (refusal !== null) {
    parts.push('# Your previous answer was refused', '', `Reason codes: ${refusal.reasons.join(', ')}`);
    for (const [field, problem] of Object.entries(refusal.problems ?? {})) parts.push(`- ${field}: ${problem}`);
    parts.push('', 'Fix exactly these, and answer again with the whole result.', '');
  }
  parts.push('# End of the bundle');
  return `${parts.join('\n')}\n`;
}
