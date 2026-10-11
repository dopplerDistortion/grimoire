import { describe, expect, it } from 'vitest';
import { createCore } from '../../src/core';

describe('the op registry', () => {
  it('describes each op for the surfaces: policy, annotations and a closed input schema', async () => {
    const core = createCore();
    try {
      const byName = Object.fromEntries(core.ops.map((op) => [op.name, op]));

      expect(Object.keys(byName).sort()).toEqual([
        'claim',
        'close',
        'comment',
        'create',
        'labels',
        'list',
        'release',
        'show',
        'sync',
        'sync_status',
        'update',
      ]);
      // Runtime verbs: the CLI and the dashboard reach them; MCP never lists them (spec §8, §10).
      expect(byName.sync).toMatchObject({ kind: 'write', policy: 'internal', inputSchema: { type: 'object', additionalProperties: false } });
      expect(byName.sync_status).toMatchObject({ kind: 'read', policy: 'internal', annotations: { readOnlyHint: true } });
      expect(byName.show).toMatchObject({
        kind: 'read',
        policy: 'agent',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', required: ['ref'], additionalProperties: false },
      });
      expect(byName.labels).toMatchObject({ kind: 'read', annotations: { readOnlyHint: true } });
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
