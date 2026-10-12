// The result a chore run submits (spec §16 Results), as `chore_start`'s brief
// gives it: JSON Schema for each kind. `chore_submit` checks results against
// these and the fail-closed guards; the brief only shows the agent the shape.
import type { ChoreKind } from '../../tracker';

const citations = {
  type: 'array',
  items: { type: 'string' },
  description: 'ids of served items (from chore_read) the result rests on; only served items may be cited',
};

const reported = {
  client: { type: 'string', maxLength: 64, description: 'your client, self-reported (recorded as unverified)' },
  model: { type: 'string', maxLength: 64, description: 'your model, self-reported (recorded as unverified)' },
};

/** The Wiki Maintainer's result: page ops and the consumption map. */
const WIKI_MAINTAINER = {
  type: 'object',
  required: ['pages', 'consumption'],
  additionalProperties: false,
  properties: {
    pages: {
      type: 'array',
      maxItems: 8,
      description: 'page writes (at most 8): each page at most 12,000 characters, and an update shrinks a page by at most 25%',
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['op', 'slug', 'title', 'kind', 'summary', 'body'],
            additionalProperties: false,
            properties: {
              op: { const: 'create' },
              slug: { type: 'string', description: 'kebab-case, at most 64 characters' },
              title: { type: 'string' },
              kind: { enum: ['failure', 'strategy'] },
              summary: { type: 'string', maxLength: 200 },
              body: { type: 'string', maxLength: 12_000 },
            },
          },
          {
            type: 'object',
            required: ['op', 'slug', 'base_hash', 'body'],
            additionalProperties: false,
            properties: {
              op: { const: 'update' },
              slug: { type: 'string' },
              base_hash: { type: 'string', description: 'the page version you were served' },
              body: { type: 'string', maxLength: 12_000 },
            },
          },
        ],
      },
    },
    consumption: {
      type: 'array',
      description: 'every batch pair, each to one or more page slugs, or to no_pattern with a reason',
      items: {
        type: 'object',
        required: ['pair'],
        additionalProperties: false,
        properties: {
          pair: { type: 'string', description: 'the pair id from the brief (<trace>@<outcome>)' },
          slugs: { type: 'array', items: { type: 'string' } },
          no_pattern: { type: 'string', description: 'why this pair shows no pattern (kept on this machine, never committed)' },
        },
      },
    },
    ...reported,
  },
};

/** The Skill Proposer's result: at most one proposal, or no_action. */
const SKILL_PROPOSER = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { enum: ['create', 'patch', 'no_action'], description: 'create a new evolved skill, patch one, or no_action when the evidence shows nothing worth proposing' },
    target: { type: 'string', description: 'the evolved skill: a new kebab-case name of at most 55 characters (create), or an existing one you were served (patch)' },
    base_version: { type: ['string', 'null'], description: 'patch: the skill version you were served; null for a create' },
    text: {
      type: 'string',
      description: 'create: the whole SKILL.md, at most 150 lines and 8,000 characters: name and description frontmatter only (the description at most 300 characters, trigger words first), then a self-contained body',
    },
    ops: {
      type: 'array',
      description: 'patch: anchored edits applied in order, each anchor matching exactly once; a patch changes at most half of the skill’s lines',
      items: {
        type: 'object',
        required: ['op', 'text'],
        additionalProperties: false,
        properties: {
          op: { enum: ['append', 'replace', 'insert-after'] },
          anchor: { type: 'string', description: 'replace and insert-after: text that occurs exactly once in the skill' },
          text: { type: 'string' },
        },
      },
    },
    citations: {
      ...citations,
      description:
        'ids of served items the proposal rests on: at least 1 pattern page (page:<slug>) and 3 traces (trace:<handle>) from 2 issues, 2 of them failing now; only served items may be cited',
    },
    claims: {
      type: 'object',
      required: ['rationale', 'failures', 'expected_signal', 'provenance'],
      additionalProperties: false,
      properties: {
        rationale: { type: 'string', maxLength: 600 },
        failures: {
          type: 'array',
          description: 'one line for each cited failing trace',
          items: { type: 'object', required: ['trace', 'line'], additionalProperties: false, properties: { trace: { type: 'string' }, line: { type: 'string' } } },
        },
        expected_signal: { type: 'string', maxLength: 600, description: 'what should change once the skill is in use' },
        provenance: { type: 'string', maxLength: 600, description: 'where the advice comes from' },
      },
    },
    ...reported,
  },
};

export const OUTPUT_SCHEMAS: Readonly<Record<ChoreKind, Record<string, unknown>>> = {
  'wiki-maintainer': WIKI_MAINTAINER,
  'skill-proposer': SKILL_PROPOSER,
};
