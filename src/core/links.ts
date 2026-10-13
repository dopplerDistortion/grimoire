// Link targets (spec §3, Links): a URL, a repo path or a git ref. Targets are
// committed and pushed, so nothing machine-specific or secret may get in.
import { invalid } from '../errors';

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const ABSOLUTE = /^(?:[a-z]:|[\\/]|~)/i;

/**
 * The target to store for `raw`: a URL with any userinfo stripped, or a repo
 * path / git ref with `/` separators. Throws INVALID for anything else: an
 * absolute or home-relative path, a path that leaves the repo, or a blank or
 * multi-line target.
 */
export function linkTarget(raw: string, field: string): string {
  const target = raw.trim();
  if (target === '') throw invalid({ [field]: 'must not be empty' });
  if (/[\r\n]/.test(target)) throw invalid({ [field]: 'must be one line' });
  if (URL_SCHEME.test(target)) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw invalid({ [field]: `"${target}" is not a valid URL` });
    }
    if (!url.username && !url.password) return target;
    url.username = '';
    url.password = '';
    return url.href;
  }
  const path = target.replace(/\\/g, '/');
  if (ABSOLUTE.test(path)) {
    throw invalid({ [field]: `"${target}" is a path on this machine; link a URL, a repo-relative path or a git ref` });
  }
  if (path.split('/').includes('..')) throw invalid({ [field]: `"${target}" leaves the repository` });
  return path;
}
