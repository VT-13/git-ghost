import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/ghost.mjs', import.meta.url));
function cmd(bin, args, cwd) { return spawnSync(bin, args, { cwd, encoding: 'utf8' }); }
function git(args, cwd) { const r = cmd('git', args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function fixture(t, { linked = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost test ')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo with spaces'); fs.mkdirSync(repo);
  git(['init', '-q'], repo); git(['config', 'user.name', 'Test'], repo); git(['config', 'user.email', 'test@example.test'], repo);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git(['add', '.'], repo); git(['commit', '-qm', 'base'], repo);
  if (linked) { const linkedPath = path.join(tmp, 'linked checkout'); git(['worktree', 'add', '-qb', 'linked', linkedPath], repo); return { tmp, repo: linkedPath, primary: repo }; }
  return { tmp, repo, primary: repo };
}
function ghost(repo, ...args) { return cmd(process.execPath, [cli, ...args], repo); }
function metadata(repo, id) { const common = git(['rev-parse', '--git-common-dir'], repo); return JSON.parse(fs.readFileSync(path.resolve(repo, common, 'ghost-meta', `${id}.json`), 'utf8')); }

test('run isolates original dirty files and index; arguments and spaced paths survive', t => {
  const { repo } = fixture(t); fs.writeFileSync(path.join(repo, 'dirty.txt'), 'keep\n'); git(['add', 'dirty.txt'], repo); fs.writeFileSync(path.join(repo, 'dirty.txt'), 'staged stays\n');
  const beforeHead = git(['rev-parse', 'HEAD'], repo), beforeIndex = fs.readFileSync(path.join(repo, '.git', 'index'));
  const r = ghost(repo, 'run', 'safe-1', '--', process.execPath, '-e', 'require("fs").writeFileSync("made file.txt", process.argv[1])', 'argument with spaces');
  assert.equal(r.status, 0, r.stderr); const task = metadata(repo, 'safe-1');
  assert.equal(fs.readFileSync(path.join(task.worktree, 'made file.txt'), 'utf8'), 'argument with spaces');
  assert.equal(git(['rev-parse', 'HEAD'], repo), beforeHead); assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), beforeIndex);
  assert.equal(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8'), 'staged stays\n');
});

test('captures nonzero command status and missing executable error', t => {
  const { repo } = fixture(t);
  let r = ghost(repo, 'run', 'nonzero', '--', process.execPath, '-e', 'process.exit(17)');
  assert.equal(r.status, 17); assert.equal(metadata(repo, 'nonzero').exitCode, 17);
  r = ghost(repo, 'run', 'missing', '--', 'ghost-no-such-executable-xyz');
  assert.equal(r.status, 1); assert.equal(metadata(repo, 'missing').state, 'error');
});

test('rejects invalid and duplicate IDs; diffs staged, unstaged, and untracked changes; clean refuses dirty then removes clean task', t => {
  const { repo } = fixture(t);
  assert.notEqual(ghost(repo, 'run', '../escape', '--', 'true').status, 0);
  assert.equal(ghost(repo, 'run', 'diffable', '--', process.execPath, '-e', 'require("fs").writeFileSync("base.txt","changed\\n"); require("child_process").execFileSync("git",["add","base.txt"]); require("fs").writeFileSync("base.txt","unstaged\\n"); require("fs").writeFileSync("new.txt","untracked contents\\n")').status, 0);
  const d = ghost(repo, 'diff', 'diffable'); assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /staged/); assert.match(d.stdout, /unstaged/); assert.match(d.stdout, /untracked contents/);
  assert.notEqual(ghost(repo, 'clean', 'diffable').status, 0);
  assert.notEqual(ghost(repo, 'run', 'diffable', '--', 'true').status, 0);
  const task = metadata(repo, 'diffable'); fs.rmSync(path.join(task.worktree, 'new.txt'));
  git(['reset', '-q', 'HEAD', '--', 'base.txt'], task.worktree); git(['checkout', '--', 'base.txt'], task.worktree);
  const c = ghost(repo, 'clean', 'diffable'); assert.equal(c.status, 0, c.stderr);
  assert.equal(fs.existsSync(task.worktree), false); assert.equal(git(['branch', '--list', 'ghost/diffable'], repo), '');
});

test('works from linked worktree and places ghost under shared git common dir', t => {
  const { repo, primary } = fixture(t, { linked: true });
  const r = ghost(repo, 'run', 'linked-task', '--', process.execPath, '-e', 'require("fs").writeFileSync("ok", "yes")'); assert.equal(r.status, 0, r.stderr);
  const task = metadata(repo, 'linked-task'); assert.equal(fs.realpathSync(path.dirname(path.dirname(task.worktree))), fs.realpathSync(path.join(primary, '.git')));
  assert.equal(fs.readFileSync(path.join(task.worktree, 'ok'), 'utf8'), 'yes');
});

test('rejects non-repositories, unborn repositories, and Git location overrides', t => {
  const { tmp, repo } = fixture(t); assert.notEqual(ghost(tmp, 'status').status, 0);
  const unborn = path.join(tmp, 'unborn'); fs.mkdirSync(unborn); git(['init', '-q'], unborn);
  assert.match(ghost(unborn, 'status').stderr, /no committed HEAD/);
  const env = { ...process.env, GIT_DIR: path.join(tmp, 'other.git') };
  const r = spawnSync(process.execPath, [cli, 'status'], { cwd: repo, encoding: 'utf8', env });
  assert.match(r.stderr, /override environment variables/);
});

test('diff includes task commits; clean retains commits and refuses tampered branch/path metadata', t => {
  const { repo } = fixture(t);
  assert.equal(ghost(repo, 'run', 'committed', '--', process.execPath, '-e', 'require("fs").writeFileSync("committed.txt","saved\\n"); require("child_process").execFileSync("git",["add","committed.txt"]); require("child_process").execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.test","commit","-m","task commit"])').status, 0);
  const d = ghost(repo, 'diff', 'committed'); assert.equal(d.status, 0, d.stderr); assert.match(d.stdout, /committed.txt/);
  assert.match(ghost(repo, 'clean', 'committed').stderr, /task has commits/);
  const task = metadata(repo, 'committed'); git(['checkout', '-b', 'tampered'], task.worktree);
  assert.match(ghost(repo, 'diff', 'committed').stderr, /unexpected branch/);
});

test('status all handles symlink metadata safely; strict command arity rejects extras', t => {
  const { repo } = fixture(t); ghost(repo, 'run', 'short', '--', 'true');
  const common = git(['rev-parse', '--git-common-dir'], repo); const meta = path.resolve(repo, common, 'ghost-meta');
  fs.unlinkSync(path.join(meta, 'short.json')); fs.symlinkSync(path.join(meta, 'missing.json'), path.join(meta, 'short.json'));
  const all = ghost(repo, 'status'); assert.match(all.stdout, /invalid metadata/);
  assert.notEqual(ghost(repo, 'status', 'short', 'extra').status, 0);
  assert.notEqual(ghost(repo, 'diff', 'short', 'extra').status, 0);
  assert.notEqual(ghost(repo, 'clean', 'short', 'extra').status, 0);
});

test('refuses metadata that points at a different worktree path', t => {
  const { repo } = fixture(t); ghost(repo, 'run', 'path-check', '--', 'true');
  const task = metadata(repo, 'path-check'); const common = git(['rev-parse', '--git-common-dir'], repo);
  const file = path.resolve(repo, common, 'ghost-meta', 'path-check.json'); task.worktree = repo; fs.writeFileSync(file, JSON.stringify(task));
  assert.match(ghost(repo, 'diff', 'path-check').stderr, /metadata path\/identity mismatch/);
  assert.match(ghost(repo, 'clean', 'path-check').stderr, /metadata path\/identity mismatch/);
});

test('untracked preview bounds large files and summarizes binary files', t => {
  const { repo } = fixture(t);
  assert.equal(ghost(repo, 'run', 'previews', '--', process.execPath, '-e', 'require("fs").writeFileSync("large.txt","x".repeat(300000)); require("fs").writeFileSync("binary.bin",Buffer.from([0,1,2]))').status, 0);
  const d = ghost(repo, 'diff', 'previews'); assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /preview truncated/); assert.match(d.stdout, /binary content omitted; 3 bytes/);
  assert.ok(d.stdout.length < 270000);
});
