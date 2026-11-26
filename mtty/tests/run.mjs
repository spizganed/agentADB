// Protocol tests for mtty's mttyd. Usage: node tests/run.mjs [path to the mttyd folder]
// They run an isolated mttyd (new HOME, other port, own tmux socket). They never touch your real login or sessions.
import { resolve } from 'node:path';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startMttyd } from '../lib/mttyd.mjs';

const dir = resolve(process.argv[2] || process.env.MTTYD_DIR || [`${process.env.HOME}/projects/mtty/mttyd`, `${process.env.HOME}/projects/Purrminal/mttyd`].find(existsSync));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what); };
const pause = ms => new Promise(r => setTimeout(r, ms));

let a;

test('the session list starts empty and names the harnesses', async () => {
  const m = await a.ask({ t: 'list' }, 'sessions');
  eq(m.list, [], 'sessions');
  ok(m.harness.includes('shell') && m.harness.includes('codex'), `harness list has shell and codex: ${m.harness}`);
});

test('the agent list has the ten agents', async () => {
  const m = await a.ask({ t: 'agents' });
  eq(m.list.map(x => x.id), ['claude', 'pi', 'pimono', 'opencode', 'codex', 'hermes', 'cursor', 'grok', 'deepseek', 'antigravity'], 'agent ids');
  for (const x of m.list) ok(typeof x.installed === 'boolean' && x.about, `agent ${x.id} has installed and about`);
});

test('the accounts list names GitHub and GitLab', async () => {
  const m = await a.ask({ t: 'accounts' });
  eq(m.list.map(x => x.id), ['github', 'gitlab'], 'account ids');
});

test('a shell session starts, shows in the list and ends', async () => {
  const cwd = `${a.home}/projects/t1`;
  mkdirSync(cwd, { recursive: true });
  const c = await a.ask({ t: 'new', name: 't1', cwd, harness: 'shell' }, 'created');
  eq(c.session, 't1', 'session name');
  const l = await a.ask({ t: 'list' }, 'sessions');
  ok(l.list.some(s => s.name === 't1' && s.window === 'shell'), 'session t1 with a shell window is listed');
  a.send({ t: 'kill', session: 't1' });
  await pause(800);
  const l2 = await a.ask({ t: 'list' }, 'sessions');
  ok(!l2.list.some(s => s.name === 't1'), 'session t1 is gone');
});

test('a new session with a first message types it when the window is ready', async () => {
  const cwd = `${a.home}/projects/t9`;
  mkdirSync(cwd, { recursive: true });
  await a.ask({ t: 'new', name: 't9', cwd, harness: 'shell', text: 'echo handoff-$((40+2))' }, 'created');
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    await pause(1000);
    const sc = await a.ask({ t: 'screen', session: 't9' }, 'screen');
    seen = JSON.stringify(sc).includes('echo handoff-');
  }
  ok(seen, 'the first message reached the window');
  a.send({ t: 'kill', session: 't9' });
  await pause(500);
});

test('a session that another client starts reaches this client', async () => {
  // A second connection starts the session; the first one must hear about it without asking.
  const { startSecond } = await import('../lib/mttyd.mjs');
  const other = await startSecond(a);
  const cwd = `${a.home}/projects/t3`;
  mkdirSync(cwd, { recursive: true });
  const heard = a.wait(m => m.t === 'sessions' && m.list.some(x => x.name === 't3'), 8000);
  other.send({ t: 'new', name: 't3', cwd, harness: 'shell' });
  await heard;
  other.close();
  a.send({ t: 'kill', session: 't3' });
  await pause(500);
});

test('a pi key for OpenCode Go makes the Go models ready for Codex and OpenCode', async () => {
  // Codex runs its own models only: a Go key never adds a model to its list. Only OpenCode Go uses the key.
  const before = await a.ask({ t: 'models', harness: 'codex' }, 'models');
  ok(!before.list.some(m => m.group !== 'Codex'), 'codex lists no Go model without a key');
  a.send({ t: 'pi-key', provider: 'opencode-go', key: 'test-key-0123456789' });
  await pause(500);
  const after = await a.ask({ t: 'models', harness: 'codex' }, 'models');
  ok(!after.list.some(m => m.group !== 'Codex'), 'codex still lists no Go model with the pi key');
  const oc = await a.ask({ t: 'models', harness: 'opencodeGO' }, 'models');
  eq(oc.ready, true, 'opencodeGO ready with the pi key');
});

test('a bad resume id is refused', async () => {
  const m = await a.ask({ t: 'new', name: 't2', cwd: a.home, harness: 'claude', resume: 'x; rm -rf /' }, 'error');
  ok(/bad session id/.test(m.error), `error says bad session id: ${m.error}`);
});

test('a new session in a missing folder is refused', async () => {
  const m = await a.ask({ t: 'new', name: 't3', cwd: `${a.home}/no-such-folder`, harness: 'shell' }, 'error');
  ok(/No such folder/.test(m.error), `error: ${m.error}`);
});

test('a bad token for an account is refused', async () => {
  const m = await a.ask({ t: 'account-token', id: 'github', token: 'short' }, 'error');
  ok(/not a token/i.test(m.error), `error: ${m.error}`);
});

test('history answers with a list', async () => {
  const m = await a.ask({ t: 'history' });
  ok(Array.isArray(m.list), 'history list');
});

test('history lists a Codex chat from its rollout file', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const dir = `${a.home}/.codex/sessions/2026/01/02`;
  mkdirSync(dir, { recursive: true });
  const rows = [
    { timestamp: '2026-01-02T10:00:00Z', type: 'session_meta', payload: { id, cwd: '/root/projects/x' } },
    { timestamp: '2026-01-02T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>phone</environment_context>' }] } },
    { timestamp: '2026-01-02T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the build' }] } },
  ];
  writeFileSync(`${dir}/rollout-2026-01-02T10-00-00-${id}.jsonl`, rows.map(r => JSON.stringify(r)).join('\n'));
  const m = await a.ask({ t: 'history' });
  const chat = m.list.find(x => x.id === id);
  ok(chat, 'the Codex chat is in history');
  eq(chat.harness, 'codex', 'harness');
  eq(chat.cwd, '/root/projects/x', 'cwd');
  eq(chat.title, 'Fix the build', 'title: the environment block is not the title');
});

test('history search finds the Codex chat by the text of a message', async () => {
  const m = await a.ask({ t: 'history-search', q: 'the BUILD' });
  const hit = m.list.find(x => x.id === '11111111-2222-3333-4444-555555555555');
  ok(hit, 'the Codex chat is a hit');
  eq(hit.snippet, 'Fix the build', 'snippet');
  eq((await a.ask({ t: 'history-search', q: 'zzqq-nothing' })).list.length, 0, 'no hit');
});

test('usage history counts the tokens of a Claude Code chat by day, once for each reply', async () => {
  const dir = `${a.home}/.claude/projects/-root-x`;
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const line = (id, out) => JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model: 'claude-haiku', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  writeFileSync(`${dir}/u1.jsonl`, [line('m1', 5), line('m1', 5), line('m2', 7)].join('\n') + '\n');
  const m = await a.ask({ t: 'usage-history', days: 3 });
  eq(m.days.length, 3, 'three days');
  const today = m.days[2].agents;
  const claude = Object.values(today)[0];
  ok(claude, 'today has a Claude Code entry');
  eq(claude.output, 12, 'output tokens: each reply once');
  eq(claude.turns, 2, 'two replies');
});

test('history lists an OpenCode chat from its database', async () => {
  // mttyd reads the database of OpenCode directly: the isolated HOME gets one with a chat in it.
  const dir = `${a.home}/.local/share/opencode`;
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(`${dir}/opencode.db`);
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, parent_id TEXT, time_archived INTEGER, time_updated INTEGER, time_created INTEGER)');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, NULL, NULL, ?, ?)').run('ses_test123', '/root', 'An OpenCode chat', 1793297080936, 1793296979769);
  db.close();
  const m = await a.ask({ t: 'history' });
  const chat = m.list.find(x => x.id === 'ses_test123');
  ok(chat, 'the OpenCode chat is in history');
  eq(chat.harness, 'opencode', 'harness');
  eq(chat.cwd, '/root', 'cwd');
  eq(chat.title, 'An OpenCode chat', 'title');
});

// Was: the screen gave the live reply. Is: the chat comes only from the transcript, so screen rows never leak into it.
test('a Claude Code window sends no chat text from its screen', async () => {
  // A stand-in for claude: it draws the screen of a working window and stays open.
  const bin = `${a.home}/bin`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/claude`, `#!/bin/sh
printf '● Writing the answer\\n'
printf '  and more text\\n\\n'
printf '✻ Thinking… (2s)\\n\\n'
printf '────────────────────────\\n'
printf '❯ \\n'
printf '────────────────────────\\n'
sleep 20
`);
  chmodSync(`${bin}/claude`, 0o755);
  const cwd = `${a.home}/projects/live`;
  mkdirSync(cwd, { recursive: true });
  const heard = a.wait(m => m.t === 'chat' && (m.items || []).some(i => /Writing the answer/.test(i.text || '')), 6000).then(() => true, () => false);
  a.send({ t: 'new', name: 'live1', cwd, harness: 'claude' });
  a.send({ t: 'attach', session: 'live1', cols: 48, rows: 16 });
  ok(!(await heard), 'no screen text in the chat');
  a.send({ t: 'kill', session: 'live1' });
  await pause(500);
});

// A user-found bug (2026-11-24): the user closed a chat and opened a new one in the same folder. The new chat has the same
// session name, and it showed the old chat until its first message.
test('a new session with the name of a closed one starts with an empty chat', async () => {
  const bin = `${a.home}/bin`;
  mkdirSync(bin, { recursive: true });
  const cwd = `${a.home}/projects/reuse`;
  mkdirSync(cwd, { recursive: true });
  const tdir = `${a.home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`;
  mkdirSync(tdir, { recursive: true });
  const old = `${tdir}/old-chat.jsonl`;
  writeFileSync(old, JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), cwd, message: { role: 'user', content: 'the old message' } }) + '\n');
  // The first stand-in names the old transcript in its status file, as Claude Code does.
  writeFileSync(`${bin}/claude`, `#!/bin/sh\nprintf '{"transcript_path":"${old}"}' > "$MTTY_STATUS"\nprintf '❯ \\n'\nsleep 30\n`);
  chmodSync(`${bin}/claude`, 0o755);
  const seen = a.wait(m => m.t === 'chat' && (m.items || []).some(i => /the old message/.test(i.text || '')), 8000);
  a.send({ t: 'new', name: 'reuse1', cwd, harness: 'claude' });
  a.send({ t: 'attach', session: 'reuse1', cols: 48, rows: 16 });
  await seen;
  // From the kill on, no chat message may carry the old chat.
  let leak = null;
  const spy = a.wait(m => { if (m.t === 'chat' && (m.items || []).some(i => /the old message/.test(i.text || ''))) leak = m; return false; }, 6000).catch(() => {});
  a.send({ t: 'kill', session: 'reuse1' });
  await a.wait(m => m.t === 'killed', 5000);
  // The second stand-in is a new Claude Code before its first message: an empty status file, no transcript.
  writeFileSync(`${bin}/claude`, `#!/bin/sh\nprintf '❯ \\n'\nsleep 30\n`);
  const made = await a.ask({ t: 'new', name: 'reuse1', cwd, harness: 'claude' }, 'created');
  eq(made.session, 'reuse1', 'the new session takes the name');
  // The app still shows the chat of the closed session: only a reset clears it.
  const reset = a.wait(m => m.t === 'chat' && m.reset, 5000).then(m => m, () => null);
  a.send({ t: 'attach', session: 'reuse1', cols: 48, rows: 16 });
  const r = await reset;
  ok(r, 'the new session sent no chat reset: the app kept the old chat');
  eq(r.items, [], 'the reset of the new session is empty');
  await spy;
  ok(!leak, `the old chat came again: ${JSON.stringify(leak)?.slice(0, 200)}`);
  a.send({ t: 'kill', session: 'reuse1' });
  await pause(500);
});

// The user (2026-11-24): the app said nothing while the agent tried its API again, as the terminal does.
test('a Claude Code window that retries its API sends the cause and the wait', async () => {
  const bin = `${a.home}/bin`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/claude`, `#!/bin/sh
printf '* Cascading… (14s · ↓ 20 tokens)\\n'
printf '  ⎿  API Error (Connection error.) · Retrying in 7 seconds… (attempt 2/10)\\n\\n'
printf '────────────────────────\\n'
printf '❯ \\n'
printf '────────────────────────\\n'
sleep 8
`);
  chmodSync(`${bin}/claude`, 0o755);
  const cwd = `${a.home}/projects/retry`;
  mkdirSync(cwd, { recursive: true });
  a.send({ t: 'new', name: 'retry1', cwd, harness: 'claude' });
  a.send({ t: 'attach', session: 'retry1', cols: 100, rows: 16 });
  const m = await a.wait(x => x.t === 'working' && x.working?.detail, 10000);
  eq(m.working.detail, 'Retrying 2/10: Connection error · next try in 7 s', 'detail');
  a.send({ t: 'kill', session: 'retry1' });
  await pause(500);
});

test('a message sent to a working window waits in the queue and goes in at the end', async () => {
  const bin = `${a.home}/bin`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/claude`, `#!/bin/sh
printf '* Pondering… (3s · ↓ 100 tokens)\\n\\n'
printf '────────────────────────\\n'
printf '❯ \\n'
printf '────────────────────────\\n'
sleep 6
printf '\\033[2J\\033[H' # the turn is over: the screen of the agent goes away
`);
  chmodSync(`${bin}/claude`, 0o755);
  const cwd = `${a.home}/projects/q1`;
  mkdirSync(cwd, { recursive: true });
  a.send({ t: 'new', name: 'q1', cwd, harness: 'claude' });
  a.send({ t: 'attach', session: 'q1', cols: 48, rows: 16 });
  await pause(2000); // the window draws its spinner
  const queued = a.wait(x => x.t === 'queue' && (x.list || []).length === 1, 8000);
  a.send({ t: 'send', session: 'q1', text: 'echo queued-ok' });
  eq((await queued).list[0].text, 'echo queued-ok', 'queued text');
  // The stand-in ends its turn: the message goes in and the queue is empty.
  await a.wait(x => x.t === 'queue' && (x.list || []).length === 0, 20000);
  a.send({ t: 'kill', session: 'q1' });
  await pause(500);
});

test('a queue that a crash left in queue.json loads, and the queue of a closed chat goes (crash of 2026-11-25)', async () => {
  const queue = JSON.stringify({ gone: [{ id: 'q7', text: 'the red text', files: [] }] });
  const b = await startMttyd({ dir, files: { '.config/mtty/queue.json': queue } });
  try {
    let left = queue;
    for (let i = 0; i < 10 && left.includes('gone'); i++) { await pause(1000); left = readFileSync(`${b.home}/.config/mtty/queue.json`, 'utf8'); }
    eq(JSON.parse(left), {}, 'the queue of a chat that no longer exists');
  } finally { await b.stop(); }
});

test('a Claude Code account is added, listed as a harness, refused twice and removed', async () => {
  const before = await a.ask({ t: 'claude-accounts' }, 'claude-accounts');
  eq(before.list.map(x => x.id), ['main'], 'only the main account at first');
  a.send({ t: 'claude-account-add', name: 'Work account' });
  const added = await a.wait(m => m.t === 'claude-accounts' && m.list.length === 2, 5000);
  eq(added.list[1].harness, 'claude_work-account', 'harness name');
  eq(added.list[1].signedIn, false, 'a new account is not signed in');
  ok(existsSync(`${a.home}/.claude-work-account`), 'the config folder exists');
  const l = await a.ask({ t: 'list' }, 'sessions');
  ok(l.harness.includes('claude_work-account'), `harness list has the account: ${l.harness}`);
  const dup = await a.ask({ t: 'claude-account-add', name: 'work account' }, 'error');
  ok(/already/.test(dup.error), dup.error);
  const main = await a.ask({ t: 'claude-account-remove', id: 'main' }, 'error');
  ok(/No such account/.test(main.error), main.error);
  a.send({ t: 'claude-account-remove', id: 'work-account' });
  await a.wait(m => m.t === 'claude-accounts' && m.list.length === 1, 5000);
  ok(!existsSync(`${a.home}/.claude-work-account`), 'the config folder is gone');
});

test('a schedule is saved, listed with its next run, refused when bad, and removed', async () => {
  const m = await a.ask({ t: 'schedule-save', schedule: { cwd: '/root', harness: 'shell', prompt: 'echo hi', repeat: 'daily', at: '07:30' } }, 'schedules');
  eq(m.list.length, 1, 'one schedule');
  ok(m.list[0].next > Date.now(), 'next run is later');
  const bad = await a.ask({ t: 'schedule-save', schedule: { cwd: 'x', harness: 'shell', prompt: '', repeat: 'daily', at: '7' } }, 'error');
  ok(/cannot run/.test(bad.error), 'a bad schedule is refused');
  eq((await a.ask({ t: 'schedule-remove', id: m.list[0].id }, 'schedules')).list.length, 0, 'removed');
});

test('two links on one chat share its reader: a link that joins late gets the chat, a new line reaches both', async () => {
  const bin = `${a.home}/bin`;
  mkdirSync(bin, { recursive: true });
  const cwd = `${a.home}/projects/shared`;
  mkdirSync(cwd, { recursive: true });
  const tdir = `${a.home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`;
  mkdirSync(tdir, { recursive: true });
  const file = `${tdir}/shared-chat.jsonl`;
  const line = (uuid, text) => JSON.stringify({ type: 'user', uuid, timestamp: new Date().toISOString(), cwd, message: { role: 'user', content: text } }) + '\n';
  writeFileSync(file, line('s1', 'the first message'));
  writeFileSync(`${bin}/claude`, `#!/bin/sh\nprintf '{"transcript_path":"${file}"}' > "$MTTY_STATUS"\nprintf '❯ \\n'\nsleep 60\n`);
  chmodSync(`${bin}/claude`, 0o755);
  const has = text => m => m.t === 'chat' && (m.items || []).some(i => (i.text || '').includes(text));
  const first = a.wait(has('the first message'), 8000);
  a.send({ t: 'new', name: 'shared1', cwd, harness: 'claude' });
  a.send({ t: 'follow', session: 'shared1' });
  await first;
  const { startSecond } = await import('../lib/mttyd.mjs');
  const other = await startSecond(a);
  try {
    const replay = other.wait(has('the first message'), 5000);
    other.send({ t: 'follow', session: 'shared1' });
    const r = await replay;
    ok(r.reset, 'the late link got the chat as a reset');
    eq(r.session, 'shared1', 'the replay names its session');
    const inA = a.wait(has('the second message'), 5000), inB = other.wait(has('the second message'), 5000);
    appendFileSync(file, line('s2', 'the second message'));
    await Promise.all([inA, inB]);
  } finally { other.close(); a.send({ t: 'kill', session: 'shared1' }); await a.wait(m => m.t === 'killed', 5000); }
});

test('an idle watcher still sends the done alert at once when the Stop hook writes', async () => {
  const bin = `${a.home}/bin`;
  const cwd = `${a.home}/projects/idle`;
  mkdirSync(cwd, { recursive: true });
  // The stand-in waits until the watcher is in its slow look (30 s with no action), then writes a Stop event as the hook does.
  writeFileSync(`${bin}/claude`, `#!/bin/sh\nprintf '{}' > "$MTTY_STATUS"\nprintf '❯ \\n'\nsleep 36\necho '{"hook_event_name":"Stop"}' >> "$MTTY_STATUS.events"\ndate +%s%N > "$MTTY_STATUS.stopped"\nsleep 30\n`);
  chmodSync(`${bin}/claude`, 0o755);
  a.send({ t: 'new', name: 'idle1', cwd, harness: 'claude' });
  const done = await a.wait(m => m.t === 'alert' && m.session === 'idle1' && m.kind === 'done', 45000);
  const at = Date.now();
  const stopped = Number(readFileSync(`${a.home}/.cache/mtty/status/idle1.claude.json.stopped`, 'utf8')) / 1e6;
  ok(done && at - stopped < 1000, `the alert came ${Math.round(at - stopped)} ms after the Stop event`);
  a.send({ t: 'kill', session: 'idle1' });
  await a.wait(m => m.t === 'killed', 5000);
});

test('an unknown message gets an error', async () => {
  const m = await a.ask({ t: 'nope', id: 7 }, 'error');
  ok(/unknown message/.test(m.error), m.error);
});

let failed = 0;
a = await startMttyd({ dir });
for (const { name, fn } of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
await a.stop();
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
