// Line splitting shared by the transcript readers.

/**
 * The lines of a JSONL text stream, split on LF alone (a CR before it is
 * dropped), streamed so a long line is never kept twice. Not `node:readline`:
 * it also breaks lines at U+2028 and U+2029, which JSON leaves raw inside
 * strings. `chunks` must be decoded text (a stream with an encoding set), so a
 * multi-byte character is never split.
 */
export async function* jsonLines(chunks: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of chunks) {
    const parts = (rest + String(chunk)).split('\n');
    rest = parts.pop()!;
    for (const part of parts) yield part.endsWith('\r') ? part.slice(0, -1) : part;
  }
  if (rest !== '') yield rest;
}
