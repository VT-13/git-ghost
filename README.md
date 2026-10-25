# Git Ghost prototype

Git Ghost runs a trusted program in a separate native Git branch and worktree. This is an early CLI prototype, not a security sandbox or a complete product. It does not merge, commit, detach commands, or copy secrets. A command receives the inherited environment and can still access shared resources available to the user.

Requires Node.js 22 or newer and Git. The default base is the current committed `HEAD`; uncommitted files and staged changes in the original worktree are excluded. The original worktree's files, index, and checked-out branch are left untouched by Git Ghost's run flow.

## Disposable demo (about 60 seconds)

```sh
git clone https://github.com/VT-13/git-ghost.git
cd git-ghost
ghost_cli="$(pwd)/bin/ghost.mjs"
demo=$(mktemp -d)
git -C "$demo" init -q
git -C "$demo" -c user.name=Demo -c user.email=demo@example.test commit --allow-empty -qm initial
cd "$demo"
git -C "$demo" status --short
node "$ghost_cli" run hello -- node -e 'require("fs").writeFileSync("hello.txt", "hello from ghost\n")'
node "$ghost_cli" status hello
node "$ghost_cli" diff hello
rm "$demo/.git/ghost/hello/hello.txt"
node "$ghost_cli" clean hello
rm -rf "$demo"
```

Run the command from inside the repository you want to use. For a useful task ID, use only letters, digits, `.`, `_`, and `-` (starting with a letter or digit), up to 64 characters. Each task ID is unique while its worktree/metadata exists.

## Commands

```sh
node bin/ghost.mjs run <task-id> -- <executable> [args...]
node bin/ghost.mjs status [task-id]
node bin/ghost.mjs diff <task-id>
node bin/ghost.mjs clean <task-id>
```

`run` creates branch `ghost/<task-id>` and worktree `<git-common-dir>/ghost/<task-id>`, then synchronously runs the executable there. Arguments are passed directly; no shell command string is constructed. Output streams to the terminal. The command's exit status or signal is recorded in metadata under `<git-common-dir>/ghost-meta/`. A missing executable is recorded as an error. Failed task worktrees are retained for inspection.

`status` prints task metadata. `diff` shows tracked changes since the recorded base commit (including task commits and staged/unstaged changes), and lists visible untracked files. Regular text files get previews capped at 256 KiB; binary content is summarized, oversized previews are marked truncated, and symlinks are refused. Ignored files remain omitted, as with Git's normal status model. `clean` removes only a non-running, clean task worktree using `git worktree remove` without force, then deletes its branch and metadata. It refuses tasks with commits since the recorded base so commits are never silently discarded; retain or remove those manually. If Git safety checks fail, it stops.

Git common-dir discovery supports linked worktrees. Metadata and task paths are checked against the common directory and expected task identity. The task worktree path and checked-out branch are checked before diff/clean. Git location/config override environment variables are rejected rather than allowed to redirect Git operations. An abruptly terminated foreground CLI can leave metadata marked `running`; there is no daemon or automatic recovery. This is intended for ordinary local repos, not hostile concurrent filesystem mutation.

## Development

```sh
npm test
npm run check
```

MIT licensed; see [LICENSE](LICENSE).
