// Seam 1: the shared patch derivation (spec §20, Concurrent body edits). The
// dashboard turns diff(base, draft) into anchored `replace` and `append` ops,
// anchored on the base; `update.body_patch` applies them. On the base they
// give the draft exactly; on a body someone changed elsewhere meanwhile they
// merge; on a body changed under the edit they fail and change nothing.
import { describe, expect, it } from 'vitest';
import { derivePatch, lineDiff } from '../../src/core/body-diff';
import { GrimoireError } from '../../src/errors';
import { applyPatch } from '../../src/core/patch';

const MAP = [
  '## Destination',
  '',
  'A v2 payments API spec, ready to slice.',
  '',
  '## Notes',
  '',
  '- Tracker conventions: docs/agents/issue-tracker.md.',
  '- Consult the grilling skill for grilling tickets.',
  '',
  '## Decisions so far',
  '',
  '- Migrate ledger amounts to bigint.',
  '',
  '## Out of scope',
  '',
  '- Multi-currency settlement.',
].join('\n');

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof GrimoireError) return error.code;
    throw error;
  }
}

/** A small seeded generator, so the property cases are the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('derivePatch', () => {
  it.each([
    ['an edit in the middle', MAP, MAP.replace('ready to slice.', 'ready to slice into tickets.')],
    ['a line added after a blank line', MAP, MAP.replace('## Out of scope', '## Not yet specified\n\n- Refund states.\n\n## Out of scope')],
    ['a line removed', MAP, MAP.replace('- Consult the grilling skill for grilling tickets.\n', '')],
    ['an edit at the very start', MAP, `# Map\n\n${MAP}`],
    ['an edit at the very end', MAP, `${MAP}\n- Crypto.`],
    ['the trailing newline dropped', 'a\nb\n', 'a\nb'],
    ['a trailing newline added', 'a\nb', 'a\nb\n'],
    ['everything replaced', 'one\ntwo', 'three'],
    ['the body cleared', 'one\ntwo\n', ''],
    ['repeated lines edited', 'x\nx\nx\nx\n', 'x\nx\ny\nx\n'],
    ['blank lines only', '\n\n\n', '\n\nfoo\n\n'],
    ['two edits far apart', MAP, MAP.replace('## Destination', '## Destination (v2)').replace('Multi-currency', 'Multi-currency and crypto')],
  ])('%s: applied to the base it gives the draft exactly', (_name, base, draft) => {
    const ops = derivePatch(base, draft);
    expect(applyPatch(base, ops).body).toBe(draft);
    for (const op of ops) expect(['replace', 'append']).toContain(op.op);
  });

  it('an empty base is one append; no change is no ops', () => {
    expect(derivePatch('', 'Hello\n')).toEqual([{ op: 'append', text: 'Hello\n' }]);
    expect(derivePatch(MAP, MAP)).toEqual([]);
  });

  it('anchors only on the changed lines when they are unique, so a neighbour’s edit still merges', () => {
    const draft = MAP.replace('A v2 payments API spec, ready to slice.', 'A v2 payments API spec.');
    expect(derivePatch(MAP, draft)).toEqual([{ op: 'replace', anchor: 'A v2 payments API spec, ready to slice.\n', text: 'A v2 payments API spec.\n' }]);
  });

  it('holds for generated edits of a line-based body', () => {
    const next = random(160);
    const words = ['- item', '', '## Heading', 'text', 'text', 'more text', '- item'];
    const pick = () => words[Math.floor(next() * words.length)]!;
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: Math.floor(next() * 12) }, pick);
      const draft = [...base];
      const edits = 1 + Math.floor(next() * 3);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(next() * (draft.length + 1));
        const roll = next();
        if (roll < 0.4) draft.splice(at, 0, `${pick()} ${round}`);
        else if (roll < 0.7 && draft.length > 0) draft.splice(Math.min(at, draft.length - 1), 1);
        else if (draft.length > 0) draft[Math.min(at, draft.length - 1)] = `changed ${round} ${e}`;
      }
      const b = base.join('\n') + (next() < 0.5 ? '\n' : '');
      const d = draft.join('\n') + (next() < 0.5 ? '\n' : '');
      const ops = derivePatch(b, d);
      expect(applyPatch(b, ops).body, JSON.stringify({ b, d, ops })).toBe(d);
    }
  });
});

describe('the derived patch on a body that changed meanwhile', () => {
  it('merges with an agent’s insert elsewhere', () => {
    const agent = MAP.replace('## Out of scope', '## Not yet specified\n\n- Refund state machine.\n\n## Out of scope');
    const draft = MAP.replace('ready to slice.', 'ready to slice into tickets.');
    const merged = applyPatch(agent, derivePatch(MAP, draft)).body;
    expect(merged).toBe(agent.replace('ready to slice.', 'ready to slice into tickets.'));
  });

  it('fails with ANCHOR_NOT_FOUND when the agent rewrote the line being edited, and changes nothing', () => {
    const agent = MAP.replace('A v2 payments API spec, ready to slice.', 'A v3 payments API spec.');
    const draft = MAP.replace('ready to slice.', 'ready to slice into tickets.');
    expect(codeOf(() => applyPatch(agent, derivePatch(MAP, draft)))).toBe('ANCHOR_NOT_FOUND');
  });

  it('fails with ANCHOR_AMBIGUOUS when the agent copied the anchored text', () => {
    const draft = MAP.replace('- Multi-currency settlement.', '- Multi-currency settlement, for now.');
    const agent = `${MAP}\n- Multi-currency settlement.\n`;
    expect(codeOf(() => applyPatch(agent, derivePatch(MAP, draft)))).toBe('ANCHOR_AMBIGUOUS');
  });
});

describe('lineDiff', () => {
  it('lists kept, removed and added lines in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { t: '=', l: 'a' },
      { t: '-', l: 'b' },
      { t: '+', l: 'B' },
      { t: '=', l: 'c' },
      { t: '+', l: 'd' },
    ]);
  });
});
