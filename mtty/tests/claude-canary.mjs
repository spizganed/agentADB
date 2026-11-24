// Canary: runs a real Claude Code through mttyd and checks the paths that the app depends on.
// Run it after every update of Claude Code: node tests/claude-canary.mjs [path to the mttyd folder]
// It copies the login of ~/.claude-b (or $CLAUDE_CANARY_CREDENTIALS) into an isolated HOME and deletes it at the end.
// It uses the model Haiku: a few small requests.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startMttyd } from '../lib/mttyd.mjs';

const dir = resolve(process.argv[2] || `${process.env.HOME}/projects/mtty/mttyd`);
const cred = process.env.CLAUDE_CANARY_CREDENTIALS || `${process.env.HOME}/.claude-b/.credentials.json`;
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); };

const a = await startMttyd({ dir });
const pane = () => execSync(`tmux -L litterbox-${a.port} capture-pane -p -t t1`, { encoding: 'utf8' });
const first = async () => (await a.ask({ t: 'list' }, 'sessions')).list[0];
async function until(fn, ms = 60000) {
  for (let t = 0; t < ms; t += 700) { await pause(700); const v = await fn(); if (v) return v; }
  return null;
}
try {
  if (!existsSync(cred)) throw new Error(`no login at ${cred}`);
  mkdirSync(`${a.home}/.claude`, { recursive: true });
  copyFileSync(cred, `${a.home}/.claude/.credentials.json`);
  if (existsSync(`${process.env.HOME}/.claude.json`)) copyFileSync(`${process.env.HOME}/.claude.json`, `${a.home}/.claude.json`);
  const cwd = `${a.home}/projects/t1`;
  mkdirSync(cwd, { recursive: true });
  await a.ask({ t: 'new', name: 't1', cwd, harness: 'claude', mode: 'manual', model: 'haiku' }, 'created', 120000);
  await pause(20000);

  // 1. A permission: the hook bridge makes a card, the answer runs the tool.
  const out = `${cwd}/canary.txt`;
  a.send({ t: 'send', session: 't1', text: `Run this bash command and say nothing else: echo canary > ${out}` });
  const perm = await until(async () => { const p = (await first())?.prompt; return p?.kind === 'permission' ? p : null; });
  check('permission card from the hook', !!perm && /Allow Bash/.test(perm?.question || ''), JSON.stringify(perm));
  a.send({ t: 'answer', session: 't1', index: 0 });
  check('the command ran after the answer', !!(await until(() => existsSync(out), 15000)));
  check('the card is gone after the answer', !!(await until(async () => !(await first())?.prompt, 15000)));
  await pause(8000);

  // 2. Questions: a form, and the answers reach the model.
  a.send({ t: 'send', session: 't1', text: 'Use the AskUserQuestion tool now with two questions: 1 single-select (Red, Green), 2 multiSelect (Cats, Dogs). Then repeat the answers in one line.' });
  const form = await until(async () => { const p = (await first())?.prompt; return p?.kind === 'form' ? p : null; });
  check('question form from the hook', !!form && form.form?.length === 2 && form.form[1].multi === true, JSON.stringify(form));
  if (form) {
    a.send({ t: 'answer', session: 't1', index: -1, answers: { [form.form[0].question]: 'Canary typed', [form.form[1].question]: 'Cats, Dogs' } });
    check('the model got the typed answer', !!(await until(async () => /Canary typed/.test(pane()), 30000)), pane().slice(-400));
  }
  await pause(5000);

  // 3. An unknown dialog: no card, but the way to the terminal.
  a.send({ t: 'send', session: 't1', text: '/config' });
  const waiting = await until(async () => (await first())?.waiting, 15000);
  check('a dialog without a card sets waiting', !!waiting, pane().slice(-300));
  execSync(`tmux -L litterbox-${a.port} send-keys -t t1 Escape`); // the first Escape clears the filter of /config, the second closes it
  await pause(500);
  execSync(`tmux -L litterbox-${a.port} send-keys -t t1 Escape`);
  check('waiting clears after Escape', !!(await until(async () => !(await first())?.waiting, 15000)));

  // 4. The slash commands come from Claude Code itself.
  const cmds = await a.ask({ t: 'commands', session: 't1' }, 'commands', 90000).catch(() => null);
  check('the command list has compact and clear', !!cmds && ['compact', 'clear'].every(n => cmds.list.some(c => c.name === n)), JSON.stringify(cmds?.list?.length));

  // 5. Chat only: a headless window answers, asks and shows its state.
  await a.ask({ t: 'new', name: 't2', cwd, harness: 'claude', mode: 'manual', model: 'haiku', headless: true }, 'created', 60000);
  const hs = async () => (await a.ask({ t: 'list' }, 'sessions')).list.find(x => x.name === 't2');
  check('a headless window is flagged', !!(await until(async () => (await hs())?.headless, 15000)));
  a.send({ t: 'send', session: 't2', text: `Run this bash command and say done: echo headless > ${cwd}/headless.txt` });
  const hperm = await until(async () => { const p = (await hs())?.prompt; return p?.kind === 'permission' ? p : null; });
  check('headless permission card', !!hperm, JSON.stringify(hperm));
  a.send({ t: 'answer', session: 't2', index: 0 });
  check('headless command ran', !!(await until(() => existsSync(`${cwd}/headless.txt`), 20000)));
  check('headless turn ends', !!(await until(async () => (await hs())?.busy === false, 40000)));

  // 6. The report has the screen and the version.
  const rep = await a.ask({ t: 'report', session: 't1' }, 'reported', 20000);
  check('the report names the version', /version \d+\.\d+\.\d+/.test(readFileSync(rep.path, 'utf8')));
} catch (e) { check('the canary ran', false, e.message); } finally {
  try { execSync(`tmux -L litterbox-${a.port} kill-server`); } catch {}
  await pause(2000); // Claude Code stops writing into the HOME
  await a.stop().catch(e => console.log(`cleanup: ${e.message}`));
}
const bad = results.filter(r => !r).length;
console.log(`${results.length - bad} of ${results.length} passed`);
process.exit(bad ? 1 : 0);
