// Markdown with raw HTML off (spec §20, Rendering): bodies and comments
// render to Preact elements, never to an HTML string, so agent-authored text
// is inert by construction: a `<script>` in a body is just text. Images show
// as links and are never fetched; external links open in a new tab and show
// their host; an issue id links to the issue; anything else (relative paths,
// `javascript:`) is shown, not linked.
import type { ComponentChildren, VNode } from 'preact';
import { hostOf } from './format';

const ISSUE_URL = /^gr-[0-9a-hjkmnp-tv-z]{5,8}(?:~[0-9a-f]{4})?$/;
const ATTEMPT_URL = /^at-[0-9a-hjkmnp-tv-z]{6}$/;
const INLINE =
  /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\s][^*\n]*)\*|\b_([^_\s][^_\n]*)_\b|(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/g;

function link(url: string, label: ComponentChildren, key: number, image = false): VNode {
  if (ISSUE_URL.test(url)) return <a key={key} href={`/issues/${url}`}>{label}</a>;
  if (ATTEMPT_URL.test(url)) return <a key={key} href={`/attempts/${url}`}>{label}</a>;
  const host = hostOf(url);
  if (host !== null) {
    return (
      <span key={key} class="md-link">
        <a href={url} target="_blank" rel="noreferrer noopener" class={image ? 'md-image' : undefined}>
          {image ? <>image: {label}</> : label}
        </a>
        <span class="md-host"> ↗ {host}</span>
      </span>
    );
  }
  return (
    <span key={key} class="md-link">
      <span class={image ? 'md-image md-inert' : 'md-inert'} title={url}>
        {image ? <>image: {label}</> : label}
      </span>
      <span class="md-host"> ({url})</span>
    </span>
  );
}

/** Inline Markdown: code spans, links, images (as links), bold, italic, bare URLs. */
export function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    const [whole, code, alt, imageUrl, label, url, bold, bold2, italic, italic2, bare] = match;
    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (imageUrl !== undefined) out.push(link(imageUrl, alt || imageUrl, key, true));
    else if (url !== undefined) out.push(link(url, inline(label!), key));
    else if (bold !== undefined || bold2 !== undefined) out.push(<strong key={key}>{inline(bold ?? bold2!)}</strong>);
    else if (italic !== undefined || italic2 !== undefined) out.push(<em key={key}>{inline(italic ?? italic2!)}</em>);
    else if (bare !== undefined) out.push(link(bare, bare, key));
    else out.push(whole);
    key++;
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'hr' };

function blocksOf(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const top = () => blocks[blocks.length - 1];
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    const previous = top();
    if (heading) blocks.push({ kind: 'h', level: heading[1]!.length, text: heading[2]! });
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) blocks.push({ kind: 'hr' });
    else if (item) {
      const ordered = item[2] !== undefined;
      if (previous?.kind === 'list' && previous.ordered === ordered) previous.items.push(item[3]!);
      else blocks.push({ kind: 'list', ordered, items: [item[3]!] });
    } else if (/^\s*>/.test(line)) {
      const text = line.replace(/^\s*>\s?/, '');
      if (previous?.kind === 'quote') previous.lines.push(text);
      else blocks.push({ kind: 'quote', lines: [text] });
    } else if (line.trim() === '') {
      blocks.push({ kind: 'p', lines: [] });
    } else if (previous?.kind === 'p' && previous.lines.length > 0) previous.lines.push(line.trim());
    else if (previous?.kind === 'list' && /^\s+\S/.test(line)) previous.items[previous.items.length - 1] += ` ${line.trim()}`;
    else blocks.push({ kind: 'p', lines: [line.trim()] });
    i++;
  }
  return blocks.filter((block) => block.kind !== 'p' || block.lines.length > 0);
}

/** A Markdown document as elements; empty text renders nothing. */
export function Markdown({ source, class: className }: { source: string; class?: string }) {
  const blocks = blocksOf(source);
  return (
    <div class={className ? `md ${className}` : 'md'}>
      {blocks.map((block, k) => {
        switch (block.kind) {
          case 'h':
            return block.level <= 2 ? <h4 key={k}>{inline(block.text)}</h4> : <h5 key={k}>{inline(block.text)}</h5>;
          case 'list': {
            const items = block.items.map((text, j) => <li key={j}>{inline(text)}</li>);
            return block.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>;
          }
          case 'quote':
            return <blockquote key={k}>{inline(block.lines.join(' '))}</blockquote>;
          case 'code':
            return (
              <pre key={k} class="md-code">
                <code>{block.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={k} />;
          default:
            return <p key={k}>{inline(block.lines.join(' '))}</p>;
        }
      })}
    </div>
  );
}
