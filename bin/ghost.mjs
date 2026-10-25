#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const OVERRIDE_ENV = /^(GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|NAMESPACE|PREFIX)|GIT_CONFIG(_.*)?)$/i;
const PREVIEW_LIMIT = 256 * 1024;
const fail = (message) => { console.error(`ghost: ${message}`); process.exitCode = 1; };
function git(args, cwd, options = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  if (r.error) throw r.error;
  return r;
}
function repo(cwd = process.cwd()) {
  const r = git(['rev-parse', '--show-toplevel', '--git-common-dir'], cwd);
  if (r.status !== 0) throw Error('current directory is not inside a Git repository');
  const [top, common] = r.stdout.trimEnd().split('\n');
  const commonDir = fs.realpathSync(path.resolve(cwd, common));
  const head = git(['rev-parse', '--verify', 'HEAD'], cwd);
  if (head.status !== 0) throw Error('repository has no committed HEAD; create a commit first');
  return { top: path.resolve(top), commonDir, head: head.stdout.trim() };
}
function dirs(r) {
  const root = path.join(r.commonDir, 'ghost');
  const meta = path.join(r.commonDir, 'ghost-meta');
  for (const p of [root, meta]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error(`refusing symlink at ${p}`);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  }
  return { root, meta };
}
function metadataFile(meta, id) { return path.join(meta, `${id}.json`); }
function readTask(meta, id, r) {
  const f = metadataFile(meta, id);
  if (!fs.existsSync(f) || fs.lstatSync(f).isSymbolicLink()) throw Error(`unknown task: ${id}`);
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  const expected = path.join(r.commonDir, 'ghost', id);
  if (data.id !== id || data.commonDir !== r.commonDir || data.worktree !== expected || data.branch !== `ghost/${id}` || !/^[a-f0-9]{40,64}$/i.test(data.base ?? ''))
    throw Error('task metadata path/identity mismatch; refusing operation');
  return { file: f, data };
}
function verifyWorktree(data, r) {
  if (!fs.existsSync(data.worktree) || fs.lstatSync(data.worktree).isSymbolicLink()) throw Error('task worktree is missing or a symlink');
  const real = fs.realpathSync(data.worktree);
  const list = git(['worktree', 'list', '--porcelain'], r.top);
  if (list.status !== 0 || !list.stdout.split('\n').some(line => line === `worktree ${real}`)) throw Error('Git does not recognize this exact worktree path');
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], data.worktree);
  if (branch.status !== 0 || branch.stdout.trim() !== data.branch) throw Error('task worktree is on an unexpected branch; refusing operation');
  const top = git(['rev-parse', '--show-toplevel'], data.worktree);
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== real) throw Error('task worktree Git pointer resolves to a different path; refusing operation');
}
function writeTask(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
function taskId(raw) { if (!ID.test(raw ?? '')) throw Error('task ID must be 1–64 letters, digits, dots, underscores, or hyphens, and start with a letter or digit'); return raw; }
function usage() {
  console.log(`Git Ghost prototype (Node.js >=22)\n\nUsage:\n  node bin/ghost.mjs run <task-id> -- <executable> [args...]\n  node bin/ghost.mjs status [task-id]\n  node bin/ghost.mjs diff <task-id>\n  node bin/ghost.mjs clean <task-id>`);
}
function run(args) {
  const id = taskId(args[0]);
  const sep = args.indexOf('--');
  if (sep !== 1 || !args[2]) throw Error('run requires -- followed by an executable and optional arguments');
  const command = args.slice(2);
  const r = repo(); const { root, meta } = dirs(r);
  const file = metadataFile(meta, id), worktree = path.join(root, id), branch = `ghost/${id}`;
  if (fs.existsSync(file) || fs.existsSync(worktree)) throw Error(`task already exists or path is occupied: ${id}`);
  const add = git(['worktree', 'add', '-b', branch, worktree, r.head], r.top);
  if (add.status !== 0) throw Error(add.stderr.trim() || 'git worktree add failed');
  const data = { id, branch, worktree, commonDir: r.commonDir, base: r.head, command, startedAt: new Date().toISOString(), state: 'running', pid: process.pid };
  try { writeTask(file, data); } catch (e) {
    // Preserve the worktree if cleanup cannot be proven safe.
    const remove = git(['worktree', 'remove', worktree], r.top);
    if (remove.status !== 0) console.error(`ghost: metadata write failed; worktree preserved at ${worktree}`);
    throw e;
  }
  console.log(`Ghost worktree: ${worktree}`);
  console.log('Base is committed HEAD; dirty files and index in the original worktree are excluded.');
  const result = spawnSync(command[0], command.slice(1), { cwd: worktree, stdio: 'inherit', env: process.env });
  data.finishedAt = new Date().toISOString(); delete data.pid;
  if (result.error) { data.state = 'error'; data.error = result.error.message; data.exitCode = null; data.signal = result.signal ?? null; }
  else { data.state = result.status === 0 ? 'completed' : 'failed'; data.exitCode = result.status; data.signal = result.signal ?? null; }
  writeTask(file, data);
  if (result.error) throw Error(`could not run executable: ${result.error.message}`);
  if (result.signal) throw Error(`command terminated by signal ${result.signal}`);
  if (result.status !== 0) { process.exitCode = result.status ?? 1; console.error(`ghost: command exited with status ${result.status}`); }
}
function status(args) {
  if (args.length > 1) throw Error('status accepts at most one task ID');
  const r = repo(); const { meta } = dirs(r);
  if (args.length) { const { data } = readTask(meta, taskId(args[0]), r); console.log(JSON.stringify(data, null, 2)); return; }
  for (const f of fs.readdirSync(meta).filter(x => x.endsWith('.json')).sort()) {
    try { const id = taskId(f.slice(0, -5)); const { data: d } = readTask(meta, id, r); console.log(`${d.id}\t${d.state}\t${d.worktree}`); }
    catch { console.log(`${f}\tinvalid metadata`); }
  }
}
function diff(args) {
  if (args.length !== 1) throw Error('diff requires exactly one task ID');
  const r = repo(); const { meta } = dirs(r); const { data } = readTask(meta, taskId(args[0]), r);
  if (data.state === 'running') throw Error('task is marked running; wait for its foreground command to finish');
  verifyWorktree(data, r);
  console.log(`Changes for ${data.id} (${data.worktree}):`);
  const d = git(['diff', '--no-ext-diff', '--no-textconv', data.base, '--', '.'], data.worktree); process.stdout.write(d.stdout); if (d.status) throw Error(d.stderr);
  const u = git(['ls-files', '--others', '--exclude-standard', '-z'], data.worktree);
  if (u.status) throw Error(u.stderr);
  for (const rel of u.stdout.split('\0').filter(Boolean)) {
    const root = fs.realpathSync(data.worktree), abs = path.resolve(root, rel);
    if (!abs.startsWith(`${root}${path.sep}`)) throw Error('unsafe untracked path');
    let cursor = root;
    for (const part of path.relative(root, abs).split(path.sep)) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) throw Error(`refusing untracked symlink: ${rel}`); }
    const st = fs.lstatSync(abs);
    console.log(`\n--- untracked: ${rel} (${st.isDirectory() ? 'directory; contents listed by Git' : 'preview below'}) ---`);
    if (st.isFile()) {
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const buf = Buffer.alloc(Math.min(st.size, PREVIEW_LIMIT)); const n = fs.readSync(fd, buf, 0, buf.length, 0); const view = buf.subarray(0, n);
        if (view.includes(0)) console.log(`[binary content omitted; ${st.size} bytes]`);
        else { process.stdout.write(view); if (!view.toString('utf8').endsWith('\n')) process.stdout.write('\n'); if (st.size > n) console.log(`[preview truncated; ${st.size - n} bytes omitted]`); }
      } finally { fs.closeSync(fd); }
    }
  }
  if (!d.stdout && !u.stdout) console.log('(clean)');
}
function clean(args) {
  if (args.length !== 1) throw Error('clean requires exactly one task ID');
  const r = repo(); const { meta } = dirs(r); const { file, data } = readTask(meta, taskId(args[0]), r);
  if (data.state === 'running') throw Error('refusing to clean a running task');
  verifyWorktree(data, r);
  const head = git(['rev-parse', 'HEAD'], data.worktree);
  if (head.status !== 0 || head.stdout.trim() !== data.base) throw Error('refusing to clean: task has commits since its recorded base; retain or remove them manually');
  const ancestor = git(['merge-base', '--is-ancestor', data.base, 'HEAD'], r.top);
  if (ancestor.status !== 0) throw Error('refusing to clean: recorded base is not reachable from the current branch, so Git may refuse branch deletion');
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], data.worktree);
  if (status.status !== 0) throw Error('could not inspect worktree status');
  if (status.stdout) throw Error('refusing to clean a dirty worktree; inspect with diff and remove changes manually');
  const removed = git(['worktree', 'remove', data.worktree], r.top);
  if (removed.status !== 0) throw Error(removed.stderr.trim() || 'git worktree remove failed');
  const deleted = git(['branch', '-d', data.branch], r.top);
  if (deleted.status !== 0) throw Error(`worktree removed, but branch deletion failed; metadata preserved. Recovery: delete ${data.branch} manually when safe, then remove ${file}. ${deleted.stderr.trim()}`);
  fs.unlinkSync(file);
  console.log(`Removed clean worktree and branch ${data.branch}.`);
}
try {
  const overrides = Object.keys(process.env).filter(k => OVERRIDE_ENV.test(k));
  if (overrides.length) throw Error(`Git location/config override environment variables are set (${overrides.join(', ')}); unset them before using Git Ghost`);
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === '--help' || action === '-h') usage();
  else if (action === 'run') run(args);
  else if (action === 'status') status(args);
  else if (action === 'diff') diff(args);
  else if (action === 'clean') clean(args);
  else throw Error(`unknown command: ${action}`);
} catch (e) { fail(e.message); }
