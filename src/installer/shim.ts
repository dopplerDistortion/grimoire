// The shell shim (spec §10, §11): `.grimoire/run.cjs`, committed, written by
// `init`. Its bytes are covered by install_format, and `run.cjs pin` is part
// of the frozen cross-pin contract.
import SHIM_SOURCE from './run.cjs?raw';

/** Where `init` writes the shim, relative to the checkout root. */
export const SHIM_PATH = '.grimoire/run.cjs';

/** The shim's text, LF line endings (the dotfolder's .gitattributes keeps it LF). */
export function shimText(): string {
  return SHIM_SOURCE.replace(/\r\n/g, '\n');
}
