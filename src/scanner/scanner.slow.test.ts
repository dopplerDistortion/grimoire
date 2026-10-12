// The scanner against the clock (spec §2 Scanner): a large, adversarial text is
// scanned and checked in linear time. In the serial `slow` project (npm run
// test:slow), with the machine to itself; the rest is in scanner.test.ts.
//
// No sample secret appears literally in this file (see scanner.test.ts).
import { describe, expect, it } from 'vitest';
import { checkHygiene, scanSecrets } from './index';

/** A PEM header or footer, assembled so that this file holds no literal key marker. */
function pem(edge: 'BEGIN' | 'END', kind: string): string {
  return ['-----' + edge, `${kind} PRIVATE KEY-----`].join(' ').replace(/  +/g, ' ');
}

describe('linear time on adversarial text', () => {
  it('scans a large, adversarial text in linear time', () => {
    const header = pem('BEGIN', 'RSA');
    const footer = pem('END', 'RSA');
    const near = [
      `token = ${'a'.repeat(15)}`,
      'secret: ' + 'x'.repeat(300),
      `https://${'u'.repeat(250)}:`,
      `ey${'A'.repeat(40)}.ey${'B'.repeat(40)}`,
      `xoxs-${'1'.repeat(200)}`,
      'Authorization: Bearer ' + '='.repeat(200),
    ].join('\n');
    // ~3 MB: near-misses for every kind of rule, then 20,000 key headers and one
    // footer (a naive "BEGIN … END" regex rescans to the footer from every header).
    const text = `${near}\n`.repeat(1_000) + `${header} ${'Q'.repeat(60)}\n`.repeat(20_000) + footer;

    const started = performance.now();
    const result = scanSecrets(text);
    const elapsed = performance.now() - started;

    expect(result).toMatchObject({ status: 'scanned', hits: [{ rule: 'private-key-unterminated' }] });
    expect(elapsed).toBeLessThan(2_000);
  });

  it('checks a large, adversarial text in linear time', () => {
    const near = [
      `<a ${'b'.repeat(300)}`,
      `<x y${'='.repeat(50)}`,
      `<!${'D'.repeat(300)}`,
      `https://${'h'.repeat(300)}`,
      `${'u.'.repeat(100)}@${'h.'.repeat(100)}`,
      `<<<<<<<${'<'.repeat(50)}`,
      `](${' '.repeat(20)}//`,
    ].join('\n');
    const text = `${near}\n`.repeat(2_000); // ~3 MB

    const started = performance.now();
    const report = checkHygiene(text);
    const elapsed = performance.now() - started;

    expect(report).toMatchObject({ status: 'checked' });
    expect(elapsed).toBeLessThan(2_000);
  });
});
