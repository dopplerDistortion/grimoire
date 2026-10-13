import { Transform } from 'node:stream';

// A `.jsonl.zst` file must end on a frame boundary to be read at all. Node
// 22's zstd decoder ends a cut-short frame without an error, so the frames
// are walked here (RFC 8878: headers and block sizes only, nothing decoded)
// and a file that stops mid-frame fails the read, on every Node.

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50; // the low 4 bits vary
const DICT_ID_BYTES = [0, 1, 2, 4];
const CONTENT_SIZE_BYTES = [0, 2, 4, 8];

type State = 'magic' | 'descriptor' | 'block' | 'skippable';
const HEADER_BYTES: Record<State, number> = { magic: 4, descriptor: 1, block: 3, skippable: 4 };

/** Passes a zstd file's bytes through unchanged, and fails at the end unless they end on a frame boundary. */
export function zstdFrameGuard(): Transform {
  let state: State = 'magic';
  let header = Buffer.alloc(0);
  let skip = 0;
  let next: State = 'magic';
  let checksum = false;

  const enter = (bytes: number, then: State): void => {
    skip = bytes;
    next = then;
    if (skip === 0) state = then;
  };

  const onHeader = (bytes: Buffer): void => {
    switch (state) {
      case 'magic': {
        const magic = bytes.readUInt32LE(0);
        if (magic === ZSTD_MAGIC) return enter(0, 'descriptor');
        if ((magic & 0xfffffff0) >>> 0 === SKIPPABLE_MAGIC) return enter(0, 'skippable');
        throw new Error('not a zstd frame');
      }
      case 'descriptor': {
        const d = bytes[0]!;
        const singleSegment = (d >> 5) & 1;
        checksum = ((d >> 2) & 1) === 1;
        const contentSize = d >> 6 === 0 ? singleSegment : CONTENT_SIZE_BYTES[d >> 6]!;
        return enter((singleSegment ? 0 : 1) + DICT_ID_BYTES[d & 3]! + contentSize, 'block');
      }
      case 'block': {
        const h = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16);
        const last = (h & 1) === 1;
        const type = (h >> 1) & 3;
        if (type === 3) throw new Error('reserved zstd block type');
        const content = type === 1 ? 1 : h >>> 3;
        return enter(content + (last && checksum ? 4 : 0), last ? 'magic' : 'block');
      }
      case 'skippable':
        return enter(bytes.readUInt32LE(0), 'magic');
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        let at = 0;
        while (at < chunk.length) {
          if (skip > 0) {
            const take = Math.min(skip, chunk.length - at);
            skip -= take;
            at += take;
            if (skip === 0) state = next;
            continue;
          }
          const want = HEADER_BYTES[state] - header.length;
          header = Buffer.concat([header, chunk.subarray(at, at + want)]);
          at += Math.min(want, chunk.length - at);
          if (header.length < HEADER_BYTES[state]) break;
          const bytes = header;
          header = Buffer.alloc(0);
          onHeader(bytes);
        }
        done(null, chunk);
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      const atBoundary = state === 'magic' && skip === 0 && header.length === 0;
      done(atBoundary ? null : new Error('the zstd frame is cut short'));
    },
  });
}
