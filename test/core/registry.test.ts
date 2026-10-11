import { describe, expect, it } from 'vitest';
import { createCore } from '../../src/core';

describe('the op registry', () => {
  it('describes each op for the surfaces: policy, annotations and a closed input schema', async () => {
    const core = createCore();
    try {
      const byName = Object.fromEntries(core.ops.map((op) => [op.name, op]));

      expect(Object.keys(byName).sort()).toEqual(['comment', 'create', 'labels', 'list', 'show', 'update']);
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
    } finally {
      await core.close();
    }
  });
});
