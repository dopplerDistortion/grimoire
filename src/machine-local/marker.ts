import path from 'node:path';
import { createFileExclusive, readTextIfExists } from './fs-atomic';

// The machine-local store's own version marker (spec §5, ADR 0011): the file
// `<git-common-dir>/grimoire/format`, in the same shape as the tracker's
// `format` file, one `key: <JSON value>` per line.

/** What this release understands of the machine-local store: it runs iff J ≤ compat ≤ K. */
export const MACHINE_FORMAT_RANGE = { J: 1, K: 1 } as const;

/** The marker v1 writes into a new machine-local store. */
export const V1_MACHINE_MARKER = { format: 1, compat: 1, requires: '1.0.0' } as const;

export interface MachineMarker {
  readonly format: number | null;
  readonly compat: number | null;
  readonly requires: string | null;
}

/** UPGRADE_REQUIRED for the machine marker. The core adds `running`, `pin` and `remedies`. */
export class MachineUpgradeRequiredError extends Error {
  override readonly name = 'MachineUpgradeRequiredError';
  readonly code = 'UPGRADE_REQUIRED' as const;
  readonly retryable = false;

  constructor(
    message: string,
    readonly details: {
      readonly marker: 'machine';
      readonly why: 'newer' | 'older';
      readonly requires: string | null;
    },
  ) {
    super(message);
  }

  toBody() {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export class MachineMarkerFile {
  readonly file: string;

  constructor(storeDir: string) {
    this.file = path.join(storeDir, 'format');
  }

  /** The marker, or undefined when the store has none yet. */
  async read(): Promise<MachineMarker | undefined> {
    const text = await readTextIfExists(this.file);
    return text === undefined ? undefined : parseMarker(text);
  }

  /** Writes the v1 marker if the store has none; never touches an existing one. */
  async ensure(): Promise<MachineMarker> {
    await createFileExclusive(this.file, serializeMarker(V1_MACHINE_MARKER));
    return (await this.read()) ?? V1_MACHINE_MARKER;
  }

  /**
   * Throws UPGRADE_REQUIRED (marker `machine`) unless J ≤ compat ≤ K. A store
   * with no marker yet passes; a marker without a readable compat counts as older.
   */
  async check(): Promise<void> {
    const marker = await this.read();
    if (marker) checkMachineMarker(marker);
  }
}

export function checkMachineMarker(marker: MachineMarker): void {
  const { J, K } = MACHINE_FORMAT_RANGE;
  const compat = marker.compat;
  if (compat !== null && compat >= J && compat <= K) return;
  const why = compat !== null && compat > K ? 'newer' : 'older';
  const requires = marker.requires;
  throw new MachineUpgradeRequiredError(
    why === 'newer'
      ? `this machine's grimoire data needs a newer grimoire (machine compat ${compat}${requires ? `, grimoire ${requires} or later` : ''}); stop grimoire work and relay the remedies to the user`
      : `this machine's grimoire data is older than this grimoire can run against (machine compat ${compat ?? 'unknown'}); stop grimoire work and relay the remedies to the user`,
    { marker: 'machine', why, requires },
  );
}

export function parseMarker(text: string): MachineMarker {
  const values = new Map<string, unknown>();
  for (const line of text.split('\n')) {
    const match = /^([^\s:][^:]*): (.*)$/.exec(line.replace(/\r$/, ''));
    if (!match) continue;
    try {
      values.set(match[1]!, JSON.parse(match[2]!));
    } catch {
      values.set(match[1]!, match[2]!);
    }
  }
  const int = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) ? value : null;
  const requires = values.get('requires');
  return {
    format: int(values.get('format')),
    compat: int(values.get('compat')),
    requires: typeof requires === 'string' ? requires : null,
  };
}

function serializeMarker(marker: typeof V1_MACHINE_MARKER): string {
  return `format: ${JSON.stringify(marker.format)}\ncompat: ${JSON.stringify(marker.compat)}\nrequires: ${JSON.stringify(marker.requires)}\n`;
}
