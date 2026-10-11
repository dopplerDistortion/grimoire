// The tracker's `format` marker and the run rule (spec §5, ADR 0011).
import { GrimoireError } from '../errors';
import { formatLine, lineValue, parseLines } from './lines';

/** What this release understands of the tracker: it runs iff J ≤ compat ≤ K. */
export const TRACKER_FORMAT_RANGE = { J: 1, K: 1 } as const;

/** The marker v1 writes into a new tracker. */
export const V1_MARKER = { format: 1, compat: 1, requires: '1.0.0' } as const;

export interface Marker {
  readonly format: number | null;
  readonly compat: number | null;
  readonly requires: string | null;
}

export function parseMarker(text: string): Marker {
  const values = new Map(parseLines(text).map(({ key, raw }) => [key, lineValue(raw)]));
  const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);
  const requires = values.get('requires');
  return {
    format: int(values.get('format')),
    compat: int(values.get('compat')),
    requires: typeof requires === 'string' ? requires : null,
  };
}

export function serializeMarker(marker: typeof V1_MARKER): string {
  return `${[
    formatLine('format', marker.format),
    formatLine('compat', marker.compat),
    formatLine('requires', marker.requires),
  ].join('\n')}\n`;
}

/**
 * Throws UPGRADE_REQUIRED (marker `store`) unless J ≤ compat ≤ K. A tracker
 * without a readable marker counts as older than this release. The core adds
 * `running`, `pin` and `remedies` to the details.
 */
export function checkTrackerMarker(marker: Marker | null): void {
  const compat = marker?.compat ?? null;
  const { J, K } = TRACKER_FORMAT_RANGE;
  if (compat !== null && compat >= J && compat <= K) return;
  const why = compat !== null && compat > K ? 'newer' : 'older';
  const requires = marker?.requires ?? null;
  throw new GrimoireError(
    'UPGRADE_REQUIRED',
    why === 'newer'
      ? `this tracker needs a newer grimoire (store compat ${compat}${requires ? `, grimoire ${requires} or later` : ''}); stop grimoire work and relay the remedies to the user`
      : `this tracker is older than this grimoire can run against (store compat ${compat ?? 'unknown'}); stop grimoire work and relay the remedies to the user`,
    { marker: 'store', why, requires },
  );
}
