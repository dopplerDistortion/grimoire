// What the Codex hook-trust contract tests share: the `hooks/list` shape Codex
// 0.162.1 answers with, and grimoire's block as `init` writes it.
import { tomlMarkers } from '../../src/installer/writer';
import { codexBlockBody } from '../../src/installer/pointers';

export interface ListedHook {
  key: string;
  command: string;
  currentHash: string;
  trustStatus: string;
  sourcePath: string;
}
export interface HooksList {
  result: { data: { hooks: ListedHook[] }[] };
}

export const TRUST = 'codex/hook-trust';
export const hooksOf = (listing: HooksList) => listing.result.data.flatMap((entry) => entry.hooks);

/** grimoire's block as `init` appends it to `.codex/config.toml`. */
export function blockText(): string {
  const { begin, end } = tomlMarkers('grimoire');
  return `${begin}\n${codexBlockBody()}${end}\n`;
}
