// The scanner (spec §2): an in-process, offline secret scan for every writer of
// agent-authored text: debriefs, excerpts, wiki pages, skill text, proposals and
// chore results. It fails closed: when it can't run, the result is `unscanned`,
// and the caller drops the text rather than write it.
import { bundledRules } from './rules';
import { createScanner, type Redaction, type SecretScan } from './secrets';

export {
  checkHygiene,
  type HygieneCheck,
  type HygieneFailure,
  type HygieneFailureReason,
  type HygieneFinding,
  type HygieneReport,
} from './hygiene';
export { bundledRules, type SecretRule } from './rules';
export {
  createScanner,
  redactionMarker,
  type Redaction,
  type ScanFailure,
  type ScanFailureReason,
  type SecretHit,
  type SecretScan,
  type SecretScanner,
} from './secrets';

const bundled = createScanner(bundledRules);

/** Finds every secret in `text` with the bundled rules. */
export function scanSecrets(text: string): SecretScan {
  return bundled.scan(text);
}

/** Replaces every secret in `text` with `[REDACTED:<rule id>]`, using the bundled rules. */
export function redactSecrets(text: string): Redaction {
  return bundled.redact(text);
}
