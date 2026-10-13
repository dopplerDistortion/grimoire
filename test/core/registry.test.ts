import { describe, expect, it } from 'vitest';
import { createCore } from '../../src/core';

describe('the op registry', () => {
  it('describes each op for the surfaces: policy, annotations and a closed input schema', async () => {
    const core = createCore();
    try {
      const byName = Object.fromEntries(core.ops.map((op) => [op.name, op]));

      expect(Object.keys(byName).sort()).toEqual([
        'activity',
        'assign',
        'chore_abandon',
        'chore_read',
        'chore_start',
        'chore_submit',
        'claim',
        'close',
        'comment',
        'create',
        'delete',
        'labels',
        'list',
        'outcome_set',
        'proposal_accept',
        'proposal_dismiss',
        'proposal_list',
        'proposal_purge',
        'proposal_reconsider',
        'proposal_reject',
        'proposal_show',
        'purge_list',
        'purge_session',
        'purge_trace',
        'quarantine',
        'reassign',
        'release',
        'reopen',
        'resolve',
        'settings_get',
        'settings_set',
        'show',
        'skill_discard',
        'skill_edit',
        'skill_list',
        'skill_read',
        'skill_record',
        'skill_show',
        'skill_strays',
        'sync',
        'sync_status',
        'unquarantine',
        'update',
        'wiki_edit',
        'wiki_list',
        'wiki_show',
      ]);
      // MCP lists exactly the agent tools of spec §8 (so far).
      expect(core.ops.filter((op) => op.mcp).map((op) => op.name).sort()).toEqual([
        'chore_abandon',
        'chore_read',
        'chore_start',
        'chore_submit',
        'claim',
        'close',
        'comment',
        'create',
        'labels',
        'list',
        'release',
        'show',
        'skill_list',
        'skill_read',
        'update',
      ]);
      // Runtime verbs: the CLI and the dashboard reach them; MCP never lists them (spec §8, §10).
      expect(byName.sync).toMatchObject({ kind: 'write', policy: 'agent', mcp: false, inputSchema: { type: 'object', additionalProperties: false } });
      expect(byName.sync_status).toMatchObject({ kind: 'read', policy: 'agent', mcp: false, annotations: { readOnlyHint: true } });
      expect(byName.show).toMatchObject({
        kind: 'read',
        policy: 'agent',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', required: ['ref'], additionalProperties: false },
      });
      expect(byName.labels).toMatchObject({ kind: 'read', annotations: { readOnlyHint: true } });
      // The gate (spec §18): people show proposals and decide them; no decision is ever offered to agents.
      for (const name of ['proposal_accept', 'proposal_reject', 'proposal_dismiss', 'proposal_reconsider', 'proposal_purge']) {
        expect(byName[name], name).toMatchObject({ kind: 'write', policy: 'human-only', mcp: false });
      }
      for (const name of ['proposal_show', 'proposal_list']) expect(byName[name], name).toMatchObject({ kind: 'read', policy: 'human-read', mcp: false });
      expect(byName.skill_list).toMatchObject({ kind: 'read', policy: 'agent', mcp: true, annotations: { readOnlyHint: true } });
      expect(byName.skill_read).toMatchObject({
        kind: 'read',
        policy: 'agent',
        mcp: true,
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', required: ['name'], additionalProperties: false },
      });
      expect(byName.skill_edit).toMatchObject({ kind: 'write', policy: 'human-only', mcp: false });
      expect(byName.skill_show).toMatchObject({ kind: 'read', policy: 'human-read', mcp: false });
      // Stray edits (spec §15): listed for people, recorded or discarded by a human only.
      expect(byName.skill_strays).toMatchObject({ kind: 'read', policy: 'human-read', mcp: false });
      expect(byName.skill_record).toMatchObject({ kind: 'write', policy: 'human-only', mcp: false, inputSchema: { required: ['stray'] } });
      expect(byName.skill_discard).toMatchObject({ kind: 'write', policy: 'human-only', mcp: false });
      expect(byName.activity).toMatchObject({ kind: 'read', policy: 'human-read', mcp: false });
      expect(byName.create).toMatchObject({
        kind: 'write',
        policy: 'agent',
        annotations: { destructiveHint: false, openWorldHint: false },
        inputSchema: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            parent: { type: 'string' },
            blocked_by: { type: 'array', items: { type: 'string' } },
            idempotency_key: { type: 'string' },
          },
        },
      });
      expect(byName.create!.annotations).not.toHaveProperty('idempotentHint');
      expect(byName.list).toMatchObject({ kind: 'read', policy: 'agent', annotations: { readOnlyHint: true } });
      for (const name of ['update', 'comment']) {
        expect(byName[name]).toMatchObject({
          kind: 'write',
          policy: 'agent',
          annotations: { destructiveHint: false, openWorldHint: false },
          inputSchema: { type: 'object', required: name === 'update' ? ['id'] : ['id', 'body'], additionalProperties: false },
        });
        expect(byName[name]!.annotations).not.toHaveProperty('idempotentHint');
      }
      expect(byName.claim).toMatchObject({
        kind: 'write',
        policy: 'agent',
        annotations: { destructiveHint: false, openWorldHint: false },
        inputSchema: { type: 'object', required: ['id'], additionalProperties: false },
      });
      expect(byName.claim!.annotations).not.toHaveProperty('idempotentHint');
      // Only the ending ops replay on their own arguments (spec §8, Results and annotations).
      for (const [name, required] of [
        ['close', ['id', 'reason']],
        ['release', ['id', 'attempt']],
      ] as const) {
        expect(byName[name]).toMatchObject({
          kind: 'write',
          policy: 'agent',
          annotations: { destructiveHint: false, openWorldHint: false, idempotentHint: true },
          inputSchema: { type: 'object', required, additionalProperties: false },
        });
      }
      expect(byName.close!.inputSchema).toMatchObject({
        properties: {
          reason: { type: 'string', enum: ['done', 'canceled'] },
          debrief: {
            type: 'object',
            required: ['asked', 'tried', 'failed', 'worked', 'next'],
            additionalProperties: false,
          },
          parent_patch: { type: 'array' },
        },
      });
      for (const name of ['update', 'comment']) {
        expect(byName[name]!.inputSchema).toMatchObject({ properties: { attempt: { type: 'string' } } });
      }
    } finally {
      await core.close();
    }
  });
});
