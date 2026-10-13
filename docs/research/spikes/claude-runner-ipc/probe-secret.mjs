// Spike D (GOK-129) throwaway probe: the R5 fallback. A per-user secret file under %LOCALAPPDATA%,
// presented on every control request over the named pipe.
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const log = (...a) => console.log('[secret]', ...a);
const dir = join(process.env.LOCALAPPDATA, `grimoire-spike-${randomBytes(4).toString('hex')}`);
mkdirSync(dir, { recursive: true });
const secretPath = join(dir, 'control.secret');
const secret = randomBytes(32).toString('base64url');
writeFileSync(secretPath, secret, { mode: 0o600, flag: 'wx' });
const icacls = (p) => spawnSync('icacls.exe', [p], { encoding: 'utf8', windowsHide: true }).stdout.trim();
log('icacls %LOCALAPPDATA%:\n' + icacls(process.env.LOCALAPPDATA));
log('icacls secret file:\n' + icacls(secretPath));

const name = String.raw`\\.\pipe\grimoire-spike-` + randomBytes(8).toString('hex');
const expected = Buffer.from(secret);
const server = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf += d;
    const i = buf.indexOf('\n');
    if (i < 0) return;
    const req = JSON.parse(buf.slice(0, i));
    const got = Buffer.from(String(req.secret ?? ''));
    const ok = got.length === expected.length && timingSafeEqual(got, expected);
    if (!ok) return sock.end(JSON.stringify({ ok: false, error: 'BAD_SECRET' }) + '\n');
    if (req.op === 'stop') { sock.end(JSON.stringify({ ok: true, stopping: true }) + '\n'); return server.close(); }
    sock.end(JSON.stringify({ ok: true, code: randomBytes(16).toString('base64url') }) + '\n');
  });
});

function client(op, secretFile) {
  const src = [
    "const net=require('net'),fs=require('fs');",
    "const secret=process.argv[3]?fs.readFileSync(process.argv[3],'utf8'):'wrong';",
    "const s=net.connect(process.argv[1]); let b=''; s.setEncoding('utf8');",
    "s.on('data',d=>b+=d); s.on('end',()=>console.log(b.trim()));",
    "s.on('connect',()=>s.write(JSON.stringify({op:process.argv[2],secret})+String.fromCharCode(10)));",
    "s.on('error',e=>{console.log('client error',e.code);process.exit(2)});",
  ].join('\n');
  return new Promise((res) => {
    const c = spawn(process.execPath, ['-e', src, name, op, ...(secretFile ? [secretFile] : [])], { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => res(out.trim()));
  });
}

server.listen(name, async () => {
  log('listening on', name);
  log('sign-in with the secret ->', await client('sign-in', secretPath));
  log('sign-in with a wrong secret ->', await client('sign-in'));
  log('stop with a wrong secret ->', await client('stop'));
  log('stop with the secret ->', await client('stop', secretPath));
  setTimeout(async () => {
    log('after stop ->', await client('sign-in', secretPath));
    rmSync(dir, { recursive: true, force: true });
    log('cleaned up', dir);
  }, 300);
});
