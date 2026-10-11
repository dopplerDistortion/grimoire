// Strict semver (semver.org 2.0.0): the only form a pin may take (spec §11).

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isStrictSemver(text: string): boolean {
  return STRICT_SEMVER.test(text);
}

/** Orders two strict semver versions by precedence (build metadata ignored): negative, zero or positive. */
export function compareSemver(a: string, b: string): number {
  const x = STRICT_SEMVER.exec(a);
  const y = STRICT_SEMVER.exec(b);
  if (!x || !y) throw new TypeError(`not strict semver: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === undefined || pb === undefined) return (pa === undefined ? 1 : 0) - (pb === undefined ? 1 : 0);
  const ia = pa.split('.');
  const ib = pb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const s = ia[i];
    const t = ib[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    if (s === t) continue;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt) return Number(s) - Number(t);
    if (ns !== nt) return ns ? -1 : 1;
    return s < t ? -1 : 1;
  }
  return 0;
}
