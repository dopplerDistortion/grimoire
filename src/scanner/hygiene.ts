// Hygiene checks (spec §18 Mechanical checks, §16 fail-closed guards): text an
// agent wrote must not hide characters, carry conflict markers or raw HTML, point
// into the dotfolder, or reference remote content. Like the secret scan, the
// checks fail closed: when they can't run, the report is `unchecked`.

export type HygieneCheck =
  | 'control-character'
  | 'conflict-marker'
  | 'html'
  | 'grimoire-path'
  | 'remote-content';

/** One hygiene problem: the check that failed and its span, `[start, end)` in UTF-16 code units. */
export interface HygieneFinding {
  readonly check: HygieneCheck;
  readonly start: number;
  readonly end: number;
}

/**
 * Why the checks could not run. Callers treat the text as failing them.
 * - `invalid-input`: the input is not a string.
 * - `check-error`: a check threw.
 */
export type HygieneFailureReason = 'invalid-input' | 'check-error';

/** The checks could not run. It carries no findings, so it can't pass for "clean". */
export interface HygieneFailure {
  readonly status: 'unchecked';
  readonly reason: HygieneFailureReason;
  /** A diagnostic for logs. It never quotes the checked text. */
  readonly detail: string;
}

export type HygieneReport =
  | { readonly status: 'checked'; readonly findings: readonly HygieneFinding[] }
  | HygieneFailure;

type Span = readonly [start: number, end: number];

// Characters a reader can't see, as code-point ranges (kept numeric so that no
// invisible character is ever written into this source file).
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], // C0 controls, except tab (09), LF (0A) and CR (0D)
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner; LRM, RLM
  [0x2028, 0x202e], // line and paragraph separators; bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates, deprecated format controls
  [0x3164, 0x3164], // Hangul filler
  [0xfeff, 0xfeff], // byte-order mark / zero-width no-break space
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff9, 0xfffb], // interlinear annotation controls
  [0xe0000, 0xe007f], // Unicode tags ("ASCII smuggling")
  [0xe0100, 0xe01ef], // supplementary variation selectors
];
const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const HIDDEN_CLASS = HIDDEN_RANGES.map(([from, to]) =>
  from === to ? char(from) : `${char(from)}-${char(to)}`,
).join('');
// A run of hidden characters, or of two or more variation selectors (one alone,
// like U+FE0F after an emoji, is ordinary).
const HIDDEN = new RegExp(`(?:[${HIDDEN_CLASS}]|[${char(0xfe00)}-${char(0xfe0f)}]{2,})+`, 'gu');

function* hiddenCharacters(text: string): Iterable<Span> {
  for (const match of text.matchAll(HIDDEN)) {
    let start = match.index;
    const end = start + match[0].length;
    // A byte-order mark that opens the text is an encoding artifact, not hidden content.
    if (start === 0 && text.charCodeAt(0) === 0xfeff) start = 1;
    if (end > start) yield [start, end];
  }
}

// git's markers: exactly seven characters at the start of a line, then a space
// and a label, or nothing. The `=======` separator alone is also a markdown
// heading underline, so it counts only beside another marker.
const CONFLICT_MARKER = /^(?:<{7}|\|{7}|>{7})(?:[ \t][^\r\n]*)?$/gm;
const CONFLICT_SEPARATOR = /^={7}$/gm;

function* conflictMarkers(text: string): Iterable<Span> {
  const markers = [...text.matchAll(CONFLICT_MARKER)];
  if (markers.length === 0) return;
  const separators = [...text.matchAll(CONFLICT_SEPARATOR)];
  for (const match of [...markers, ...separators]) yield [match.index, match.index + match[0].length];
}

// Raw HTML, which a renderer may turn into hidden or fetched content:
// - comments, declarations, CDATA and processing instructions;
// - any tag with an attribute (`<x style=…>`, `<img src=…>`);
// - closing and self-closing tags of HTML elements;
// - the elements that hide, swallow or run what follows even when bare.
// Code spans and fences are not exempt: telling them apart the way every
// renderer does needs a full CommonMark parser, and a disagreement would let
// HTML through. A bare `<word>` is a placeholder (`<slug>`, `<issue id>`) or a
// type argument (`Promise<void>`), and an unknown closing tag is a prompt-style
// section (`</what-to-do>`), so neither counts. Every repeat is bounded, so no
// input can make the scan quadratic.
const HTML_ELEMENTS = [
  'a|abbr|acronym|address|applet|area|article|aside|audio|b|base|basefont|bdi|bdo|bgsound|big|blink',
  'blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|datalist|dd|del|details',
  'dfn|dialog|dir|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|frame|frameset',
  'h[1-6]|head|header|hgroup|hr|html|i|iframe|image|img|input|ins|isindex|kbd|keygen|label|legend|li',
  'link|listing|main|map|mark|marquee|math|menu|menuitem|meta|meter|multicol|nav|nextid|nobr|noembed',
  'noframes|noscript|object|ol|optgroup|option|output|p|param|picture|plaintext|pre|progress|q|rb|rp',
  'rt|rtc|ruby|s|samp|script|search|section|select|slot|small|source|spacer|span|strike|strong|style',
  'sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|tt|u|ul',
  'var|video|wbr|xmp',
].join('|');
const HIDING_ELEMENTS =
  'script|style|template|textarea|xmp|noscript|noembed|noframes|iframe|plaintext|details|object|embed|svg|math|frameset|frame|applet';
const END_OF_NAME = '(?=[\\s/>])';
const HTML = new RegExp(
  [
    '<!--',
    '<![A-Za-z[][^<>]{0,2000}>?',
    '<\\?[A-Za-z][^<>]{0,2000}>?',
    '<[A-Za-z][\\w.:-]{0,100}\\s[^<>=]{0,2000}=[^<>]{0,2000}>',
    `<\\/(?:${HTML_ELEMENTS})${END_OF_NAME}\\s{0,100}>`,
    `<(?:${HTML_ELEMENTS})${END_OF_NAME}(?:\\s[^<>]{0,2000})?\\/>`,
    `<(?:${HIDING_ELEMENTS})${END_OF_NAME}[^<>]{0,2000}>`,
  ].join('|'),
  'gi',
);

function* html(text: string): Iterable<Span> {
  for (const match of text.matchAll(HTML)) yield [match.index, match.index + match[0].length];
}

// A path into the dotfolder, in either separator and any case (Windows and macOS
// file systems ignore case). `foo.grimoire/` and `@scope/grimoire` are not.
const GRIMOIRE_PATH = /(?<![\w.-])\.grimoire[\\/][^\s'"`<>()[\]{},;]*/gi;

function* grimoirePaths(text: string): Iterable<Span> {
  for (const match of text.matchAll(GRIMOIRE_PATH)) {
    yield trimTrailingPunctuation(text, match.index, match.index + match[0].length);
  }
}

// References that make a reader or a renderer fetch content from another host:
// network URLs, protocol-relative markdown link targets, `www.` autolinks and
// scp-style git remotes. Loopback hosts are local, not remote.
const URL_CHARS = `[^\\s'"\`<>()[\\]{}]`;
const REMOTE = [
  new RegExp(`\\b(?:https?|ftps?|wss?|sftp|ssh|git|svn|rsync|smb)://(${URL_CHARS}+)`, 'gi'),
  new RegExp(`(?<=\\]\\(\\s{0,10}<?)//(${URL_CHARS}+)`, 'g'),
  new RegExp(`(?<![\\w.@/-])(www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)(?:[/?#]${URL_CHARS}*)?`, 'gi'),
  /(?<![\w.\/-])[\w.-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(?!\/\/)[\w.~-][\w.\/~-]*/g,
];

function* remoteContent(text: string): Iterable<Span> {
  for (const pattern of REMOTE) {
    for (const match of text.matchAll(pattern)) {
      if (isLoopback(hostOf(match[1] ?? ''))) continue;
      yield trimTrailingPunctuation(text, match.index, match.index + match[0].length);
    }
  }
}

/** The host of an authority-first string: `user:pw@Host:port/path` → `host`. */
function hostOf(rest: string): string {
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  if (hostPort.startsWith('[')) return hostPort.slice(0, hostPort.indexOf(']') + 1);
  return hostPort.split(':', 1)[0] ?? '';
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '0.0.0.0' ||
    host === '[::1]'
  );
}

/** Sentence punctuation after a URL or path is not part of it. */
function trimTrailingPunctuation(text: string, start: number, end: number): Span {
  while (end > start + 1 && '.,:;!?'.includes(text[end - 1] ?? '')) end--;
  return [start, end];
}

const CHECKS: readonly (readonly [HygieneCheck, (text: string) => Iterable<Span>])[] = [
  ['control-character', hiddenCharacters],
  ['conflict-marker', conflictMarkers],
  ['html', html],
  ['grimoire-path', grimoirePaths],
  ['remote-content', remoteContent],
];

/** Runs every hygiene check over `text`. Findings are in order of position. */
export function checkHygiene(text: string): HygieneReport {
  if (typeof text !== 'string') {
    return {
      status: 'unchecked',
      reason: 'invalid-input',
      detail: `expected a string, got ${text === null ? 'null' : typeof text}`,
    };
  }
  try {
    const findings: HygieneFinding[] = [];
    for (const [check, find] of CHECKS) {
      // Overlapping spans from one check (a URL that is also an scp remote) are one finding.
      const spans = [...find(text)].sort((a, b) => a[0] - b[0]);
      let last: { check: HygieneCheck; start: number; end: number } | undefined;
      for (const [start, end] of spans) {
        if (last && start < last.end) {
          last.end = Math.max(last.end, end);
        } else {
          last = { check, start, end };
          findings.push(last);
        }
      }
    }
    return { status: 'checked', findings: findings.sort((a, b) => a.start - b.start) };
  } catch (error) {
    return {
      status: 'unchecked',
      reason: 'check-error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
