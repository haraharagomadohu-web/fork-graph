# Fork Graph

**See every fork of your Claude Code conversations as a git-graph — and jump back to "that good state" in one click.**

Claude Code sessions branch constantly: `/rewind`, *Fork conversation from here*, `--fork-session`, resumed chats. After a week you have dozens of sessions and no way to remember which branch had the good result. Fork Graph reads your local session history, reconstructs the full fork genealogy, and lets you annotate, search, and reopen any point in it.

<!-- TODO: hero GIF (images/hero.gif) — graph, click node, memo, Open in Claude Code.
     Requires the repository field in package.json before vsce can rewrite relative URLs. -->

## Features

- **Fork genealogy as a git-graph** — every prompt is a node; session-internal rewinds and cross-session forks are merged into one tree, even though Claude Code rewrites session/message IDs on fork
- **Memos and pins** — leave subjective notes ("this was the good state") on any node; they survive restarts, reloads, and forks
- **Open in Claude Code** — reopen the session at any node, via the official extension or a CLI terminal tab (toggle; CLI is the default)
- **Search** — incremental text search over prompts + memos, plus a calendar with date and time-range filters; non-matching nodes dim so you keep the genealogy context
- **Pinned-only view** — show just your pinned nodes and their ancestor paths, with lanes compacted
- **Project switcher** — browse the session history of any project folder, newest first; sessions from other folders open via CLI with the right working directory
- **Soft delete with restore preview** — hide a branch from the graph (your data is never touched); before restoring, preview the tree in a separate tab to see exactly where it reconnects
- **/compact markers** — a double wavy line (≈) crosses the edge where the context was compacted
- **Auto reload** — the graph follows your conversations live as session files grow
- **Deleted-session awareness** — sessions hidden in the official UI show as dashed pills and can still be opened via CLI
- **4 languages** — English (default), 日本語, 中文, 한국어

## Getting started

1. Install the extension
2. Run **Fork Graph: Open** from the Command Palette (or click the fork icon in the editor title bar)
3. Click a node → read the prompt, leave a memo, pin it, or press **Open in Claude Code**

## Requirements

- [Claude Code](https://claude.com/claude-code) — sessions are read from `~/.claude/projects/`
- To reopen sessions: the Claude Code CLI (`claude`) on your PATH, and/or the official *Claude Code for VS Code* extension

## Privacy

Fork Graph runs entirely on your machine. It **reads** your local session files (`~/.claude/projects/**/*.jsonl`) and **never writes to them, and never sends anything anywhere**. Memos, pins, and settings are stored in VS Code's local storage.

## How it works (short version)

Claude Code rewrites `sessionId`/`uuid` when a conversation is forked, so files can't be joined by IDs. Fork Graph canonicalizes records by `timestamp + type + content fingerprint` (with a secondary merge by stable prompt/request IDs for the one record that forking re-stamps), which reconstructs the cross-file fork DAG regardless of read order. Details live in the [design docs](https://github.com/haraharagomadohu-web/fork-graph/tree/main/docs).

## License

[MIT](https://opensource.org/license/mit/)
