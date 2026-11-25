// Starts an isolated mttyd and gives a small client for its WebSocket protocol.
// The mttyd gets a new empty HOME, its own port and its own tmux socket (MTTY_SOCK), so it never touches a real mttyd or its sessions.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** A second WebSocket connection to the same mttyd. */
export async function startSecond(client) {
  const token = readFileSync(join(client.home, '.config', 'mtty', 'token'), 'utf8').trim();
  const { WebSocket } = createRequire(join(client.dir, 'package.json'))('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${client.port}/?token=${token}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return { send: m => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

// [files]: { path in the new home: text }, written before mttyd starts (a state file that a run before left, for example).
export async function startMttyd({ dir, port = 20000 + Math.floor(Math.random() * 20000), files = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'litterbox-'));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), text); }
  const sock = `litterbox-${port}`;
  // ~/bin of the new home comes first: a test can put a stand-in for an agent there.
  const env = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, MTTY_PORT: String(port), MTTY_SOCK: sock };
  const child = spawn('node', ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mttyd did not start:\n${log}`)), 20000);
    const on = d => { log += d; if (log.includes('mttyd on ws://')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', code => reject(new Error(`mttyd exited with ${code}:\n${log}`)));
  });
  const token = readFileSync(join(home, '.config', 'mtty', 'token'), 'utf8').trim();
  const { WebSocket } = createRequire(join(dir, 'package.json'))('ws');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const seen = []; // every JSON message, in order
  const waiters = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(raw);
    seen.push(m);
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });

  const client = {
    home, port, seen, dir,
    send: m => ws.send(JSON.stringify(m)),
    /** Waits for the next message that matches `test` (a type string or a function). */
    wait(test, ms = 10000) {
      const fn = typeof test === 'string' ? m => m.t === test : test;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${typeof test === 'string' ? test : 'a message'}`)), ms);
        waiters.push({ test: fn, resolve: m => { clearTimeout(timer); resolve(m); } });
      });
    },
    /** Sends a message and waits for the reply of type `reply`. Old messages of that type are dropped first. */
    ask(m, reply = m.t, ms = 10000) {
      for (let i = seen.length - 1; i >= 0; i--) if (seen[i].t === reply) seen.splice(i, 1);
      const p = client.wait(reply, ms);
      client.send(m);
      return p;
    },
    async stop() {
      ws.close();
      child.kill();
      spawn('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); // only the socket of this run
      await new Promise(r => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    },
  };
  return client;
}
