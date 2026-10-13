import { describe, expect, it } from 'vitest';
import { createCore } from '../../../src/core';
import { globalHelp } from '../../../src/surfaces/cli/args';

describe('grimoire --help', () => {
  const help = () => {
    const core = createCore();
    try {
      return globalHelp(core.ops) as { verbs: { verb: string; policy: string }[] };
    } finally {
      void core.close();
    }
  };

  it('lists every runtime verb of spec §10, start and open included', () => {
    const verbs = help().verbs.map((entry) => entry.verb);
    expect(verbs).toEqual(expect.arrayContaining(['init', 'start', 'open', 'leave', 'uninstall', 'status', 'doctor', 'runner enable', 'runner disable', 'chore run']));
    // Spec §10 names the proposal purge beside its sibling purges.
    expect(verbs).toEqual(expect.arrayContaining(['purge trace', 'purge session', 'purge proposal']));
    expect(verbs).not.toContain('proposal purge');
  });

  it('shows the verbs that refuse agent markers but need no terminal (spec §7) apart from human-read ones', () => {
    const byVerb = new Map(help().verbs.map((entry) => [entry.verb, entry.policy]));
    for (const verb of ['init', 'start', 'open', 'chore run']) expect(byVerb.get(verb), verb).toBe('refuses-agent-markers');
  });
});
