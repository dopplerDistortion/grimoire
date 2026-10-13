// Spike D (GOK-129) throwaway probe: a Node named-pipe control channel on Windows.
// Usage: node probe-pipe.mjs [--readable-writable-all]
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const widen = process.argv.includes('--readable-writable-all');
const name = String.raw`\\.\pipe\grimoire-spike-` + randomBytes(8).toString('hex');
const log = (...a) => console.log('[probe]', ...a);
let connections = 0;

function run(cmd, args) {
  return new Promise((res) => {
    const c = spawn(cmd, args, { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => res({ code, out: out.trim() }));
  });
}

const server = net.createServer((sock) => {
  connections++;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const req = JSON.parse(line);
      if (req.op === 'sign-in') sock.write(JSON.stringify({ ok: true, code: randomBytes(16).toString('base64url') }) + '\n');
      else if (req.op === 'stop') {
        sock.end(JSON.stringify({ ok: true, stopping: true }) + '\n');
        server.close(() => log('server closed after stop'));
      } else sock.write(JSON.stringify({ ok: false, error: 'UNKNOWN_OP' }) + '\n');
    }
  });
});

const listenOpts = widen ? { path: name, readableAll: true, writableAll: true } : { path: name };
server.listen(listenOpts, async () => {
  log('node', process.version, 'listening on', name, widen ? '(readableAll+writableAll)' : '(defaults)');
  // 1. a second listen on the same name must fail (single instance / anti-squat)
  await new Promise((res) => {
    const s2 = net.createServer();
    s2.on('error', (e) => { log('second listen on same name ->', e.code); res(); });
    s2.listen(name, () => { log('second listen on same name -> UNEXPECTEDLY OK'); s2.close(res); });
  });
  // 2. ACL evidence
  const sd = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'pipe-sddl.ps1'), name]);
  log(sd.out);
  // 3. request/response from a separate process
  const clientSrc = [
    "const net=require('net'); const s=net.connect(process.argv[1]); let b='';",
    "s.setEncoding('utf8'); s.on('data',d=>{b+=d; if(b.includes(String.fromCharCode(10))){console.log(b.trim()); s.end();}});",
    "s.on('connect',()=>s.write(JSON.stringify({op:process.argv[2]})+String.fromCharCode(10)));",
    "s.on('error',e=>{console.log('client error',e.code); process.exit(2)});",
  ].join('\n');
  const r1 = await run(process.execPath, ['-e', clientSrc, name, 'sign-in']);
  log('client sign-in ->', r1.out, 'exit', r1.code);
  const r2 = await run(process.execPath, ['-e', clientSrc, name, 'stop']);
  log('client stop ->', r2.out, 'exit', r2.code);
  setTimeout(async () => {
    const r3 = await run(process.execPath, ['-e', clientSrc, name, 'sign-in']);
    log('client after stop ->', r3.out, 'exit', r3.code, '| connections seen:', connections);
  }, 300);
});
