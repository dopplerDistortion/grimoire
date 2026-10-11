/*! The secret rules below are adapted from the gitleaks default configuration
 * (https://github.com/gitleaks/gitleaks, config/gitleaks.toml): rule ids,
 * regexes, keywords, entropy thresholds and allowlists, translated from Go RE2 to
 * JavaScript and tuned for redaction. gitleaks is distributed under this license:
 *
 * MIT License
 *
 * Copyright (c) 2019 Zachary Rice
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** One secret rule, gitleaks-style: a regex plus the filters that keep it high-confidence. */
export interface SecretRule {
  /** Kebab-case, named in hits and in redaction markers. */
  readonly id: string;
  readonly description: string;
  /** JavaScript regex source. The scanner adds the `g` flag (and `d` for `secretGroup`). */
  readonly regex: string;
  /** Extra regex flags, such as `i`. */
  readonly flags?: string;
  /** The capture group holding the secret; the hit spans only that group. Default: the whole match. */
  readonly secretGroup?: number;
  /** Lowercase prefilter: the rule runs only on text containing one of these. */
  readonly keywords?: readonly string[];
  /** Minimum Shannon entropy (bits per character) of the secret. */
  readonly entropy?: number;
  /** Regexes over the secret; a secret matching any of them is not a hit. */
  readonly allow?: readonly string[];
  /** Lowercase substrings; a secret containing any of them is not a hit. */
  readonly stopwords?: readonly string[];
}

const PEM_BEGIN = '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY';
const PEM_END = '-----END[ A-Z0-9_-]{0,100}PRIVATE KEY';

// Rules are in priority order: when hits overlap, they merge into one hit named
// after the earliest rule. Specific rules come first; the generic ones last.
export const bundledRules: readonly SecretRule[] = [
  // Private keys. A block whose header meets no END line before the next header
  // or the end of the text is unterminated, and is redacted through the end of
  // the text: nothing after its header can be trusted to be key-free. Scanning
  // stops at the next header, so many headers can't make a scan quadratic.
  {
    id: 'private-key-unterminated',
    description: 'Private key block with no END line, through the end of the text',
    regex: `${PEM_BEGIN}(?=(?:(?!${PEM_END}|${PEM_BEGIN})[\\s\\S])*(?:${PEM_BEGIN}|$))[\\s\\S]*`,
    flags: 'i',
    keywords: ['-----begin'],
  },
  {
    id: 'private-key',
    description: 'Private key block',
    regex: `${PEM_BEGIN}(?: BLOCK)?-----(?:(?!${PEM_BEGIN})[\\s\\S])*?${PEM_END}(?: BLOCK)?-----`,
    flags: 'i',
    keywords: ['-----begin'],
  },

  // GitHub
  {
    id: 'github-pat',
    description: 'GitHub personal access token (classic)',
    regex: 'ghp_[0-9a-zA-Z]{36}',
    keywords: ['ghp_'],
    entropy: 3,
  },
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub fine-grained personal access token',
    regex: 'github_pat_\\w{82}',
    keywords: ['github_pat_'],
    entropy: 3,
  },
  {
    id: 'github-oauth',
    description: 'GitHub OAuth access token',
    regex: 'gho_[0-9a-zA-Z]{36}',
    keywords: ['gho_'],
    entropy: 3,
  },
  {
    id: 'github-app-token',
    description: 'GitHub App user-to-server or installation token',
    regex: '(?:ghu|ghs)_[0-9a-zA-Z]{36}',
    keywords: ['ghu_', 'ghs_'],
    entropy: 3,
  },
  {
    id: 'github-refresh-token',
    description: 'GitHub refresh token',
    regex: 'ghr_[0-9a-zA-Z]{36}',
    keywords: ['ghr_'],
    entropy: 3,
  },

  // AWS
  {
    id: 'aws-access-token',
    description: 'AWS access key id',
    regex: '\\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\\b',
    keywords: ['a3t', 'akia', 'asia', 'abia', 'acca'],
    entropy: 3,
    allow: ['EXAMPLE$'],
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key, by its name',
    regex:
      '(?:aws[_.-]?)?secret[_.-]?access[_.-]?key["\']?\\s{0,3}(?::=|=>|=|:)\\s{0,3}["\']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])',
    flags: 'i',
    secretGroup: 1,
    keywords: ['secret'],
    entropy: 3.5,
    allow: ['EXAMPLE'],
  },

  // Anthropic
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    regex: '\\bsk-ant-api\\d{2}-[\\w-]{20,}',
    keywords: ['sk-ant-'],
    entropy: 3,
  },
  {
    id: 'anthropic-admin-api-key',
    description: 'Anthropic Admin API key',
    regex: '\\bsk-ant-admin\\d{2}-[\\w-]{20,}',
    keywords: ['sk-ant-'],
    entropy: 3,
  },
  {
    id: 'anthropic-oauth-token',
    description: 'Anthropic OAuth access or refresh token (Claude Code setup-token)',
    regex: '\\bsk-ant-o[ar]t\\d{2}-[\\w-]{20,}',
    keywords: ['sk-ant-'],
    entropy: 3,
  },

  // OpenAI
  {
    id: 'openai-api-key',
    description: 'OpenAI API key (project, service account, admin or legacy)',
    regex: '\\bsk-(?:proj|svcacct|admin)-[\\w-]{20,}|\\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\\b',
    keywords: ['sk-'],
    entropy: 3,
  },

  // Slack
  {
    id: 'slack-bot-token',
    description: 'Slack bot token',
    regex: 'xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*',
    keywords: ['xoxb'],
    entropy: 3,
  },
  {
    id: 'slack-user-token',
    description: 'Slack user token',
    regex: 'xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}',
    keywords: ['xoxp-', 'xoxe-'],
    entropy: 2,
  },
  {
    id: 'slack-app-token',
    description: 'Slack app-level token',
    regex: 'xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+',
    flags: 'i',
    keywords: ['xapp'],
    entropy: 2,
  },
  {
    id: 'slack-config-access-token',
    description: 'Slack configuration access token',
    regex: 'xoxe\\.xox[bp]-\\d-[A-Z0-9]{163,166}',
    flags: 'i',
    keywords: ['xoxe.xoxb-', 'xoxe.xoxp-'],
    entropy: 2,
  },
  {
    id: 'slack-config-refresh-token',
    description: 'Slack configuration refresh token',
    regex: 'xoxe-\\d-[A-Z0-9]{146}',
    flags: 'i',
    keywords: ['xoxe-'],
    entropy: 2,
  },
  {
    id: 'slack-legacy-bot-token',
    description: 'Slack legacy bot token',
    regex: 'xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26}',
    keywords: ['xoxb'],
    entropy: 2,
  },
  {
    id: 'slack-legacy-token',
    description: 'Slack legacy token',
    regex: 'xox[os]-\\d+-\\d+-\\d+-[a-fA-F\\d]+',
    keywords: ['xoxo', 'xoxs'],
    entropy: 2,
  },
  {
    id: 'slack-legacy-workspace-token',
    description: 'Slack legacy workspace token',
    regex: 'xox[ar]-(?:\\d-)?[0-9a-zA-Z]{8,48}',
    keywords: ['xoxa', 'xoxr'],
    entropy: 2,
  },
  {
    id: 'slack-webhook-url',
    description: 'Slack incoming webhook URL',
    regex: '(?:https?://)?hooks\\.slack\\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}',
    keywords: ['hooks.slack.com'],
  },

  // Other high-confidence tokens: a vendor prefix or a fixed shape.
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token',
    regex: '\\bglpat-[\\w.-]{20,}',
    keywords: ['glpat-'],
    entropy: 3,
  },
  {
    id: 'npm-access-token',
    description: 'npm access token',
    regex: '\\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])',
    keywords: ['npm_'],
    entropy: 2,
  },
  {
    id: 'pypi-upload-token',
    description: 'PyPI upload token',
    regex: 'pypi-AgEIcHlwaS5vcmc[\\w-]{50,}',
    keywords: ['pypi-ageichlwas5vcmc'],
    entropy: 3,
  },
  {
    id: 'stripe-access-token',
    description: 'Stripe secret or restricted key',
    regex: '\\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\\b',
    keywords: ['sk_test', 'sk_live', 'sk_prod', 'rk_test', 'rk_live', 'rk_prod'],
    entropy: 2,
  },
  {
    id: 'gcp-api-key',
    description: 'Google Cloud API key',
    regex: '\\bAIza[\\w-]{35}(?![\\w-])',
    keywords: ['aiza'],
    entropy: 4,
  },
  {
    id: 'huggingface-access-token',
    description: 'Hugging Face access token',
    regex: '\\bhf_[A-Za-z]{34}(?![A-Za-z0-9_])',
    keywords: ['hf_'],
    entropy: 2,
  },
  {
    id: 'linear-api-key',
    description: 'Linear API key',
    regex: '\\blin_api_[A-Za-z0-9]{40}(?![A-Za-z0-9])',
    keywords: ['lin_api_'],
    entropy: 2,
  },
  {
    id: 'sendgrid-api-token',
    description: 'SendGrid API key',
    regex: '\\bSG\\.[\\w=.-]{66}(?![\\w=.-])',
    keywords: ['sg.'],
    entropy: 2,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    regex: '\\bey[A-Za-z0-9]{17,}\\.ey[A-Za-z0-9/\\\\_-]{17,}\\.(?:[A-Za-z0-9/\\\\_-]{10,}={0,2})?(?![A-Za-z0-9/\\\\_=-])',
    keywords: ['ey'],
    entropy: 3,
  },

  // Generic, high-confidence by context: a credential named as one, with an
  // entropy floor. Each redacts only the value, so the name stays readable.
  {
    id: 'authorization-header',
    description: 'Credential in an Authorization header',
    regex: '\\bauthorization["\']?\\s{0,3}[:=]\\s{0,3}["\']?(?:bearer|basic|token)\\s+([A-Za-z0-9._~+/=-]{16,})',
    flags: 'i',
    secretGroup: 1,
    keywords: ['authorization'],
    entropy: 3,
  },
  {
    id: 'url-credentials',
    description: 'Password in a URL',
    regex: '\\b[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\\s:@/?#\'"`<>]{1,256}:([^\\s:@/?#\'"`<>${}*]{3,256})@',
    secretGroup: 1,
    keywords: ['://'],
    entropy: 3,
  },
  {
    id: 'generic-api-key',
    description: 'Value assigned to a key, secret, token, password or credential',
    regex:
      // The value may hold `@`, but stops at one that starts a host (`token:<value>@github.com`).
      '(?:api[_.-]?key|secret|token|passw(?:or)?d|pwd|credentials?|(?:access|private|signing|encryption|master)[_.-]?key)[\\w.-]{0,20}["\']?\\s{0,3}(?::=|=>|=|:)\\s{0,3}["\'`]?((?:[\\w.=+/~!#%^*-]|@(?![\\w-]+\\.[A-Za-z])){16,})',
    flags: 'i',
    secretGroup: 1,
    keywords: ['api', 'key', 'secret', 'token', 'passw', 'pwd', 'credential'],
    entropy: 3.5,
    // A value with no digit is a name or a reference, not a generated secret.
    allow: ['^[^0-9]*$'],
    stopwords: ['example', 'sample', 'dummy', 'placeholder', 'changeme', 'redacted', 'xxxxxx', '000000', 'your_', 'your-'],
  },
];
