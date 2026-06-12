# Contributing to Fork Graph

Thanks for your interest! Issues and pull requests are welcome, in English or Japanese.

## Development setup

```bash
cd fork-graph-ext
npm install
npm run compile     # type-check + build to out/
npm run redeploy    # build → package .vsix → install into your VS Code
```

Or open `fork-graph-ext/` in VS Code and press `F5` to launch an Extension Development Host.

## Project layout

- `fork-graph-ext/src/sessionLoader.ts` — reads `~/.claude/projects/**/*.jsonl`, canonicalizes records, builds the fork graph
- `fork-graph-ext/src/extension.ts` — extension host code + the entire Webview UI (single self-contained HTML template)
- `docs/` — design documents (Japanese). Start with `CLAUDE.md` at the repo root for a guided tour
- `fork-graph-ext/scripts/` — verification scripts you can run against your own session data

## Ground rules

- **Never write to session files.** Fork Graph is strictly read-only on `~/.claude/projects/`. Features like soft delete must be display-only.
- **Persist per-node state by stable key (`node.key`), never by `uuid`** — uuids are rewritten on fork/reload (see `docs/S1-timestamp-merge-design.md` §3a).
- New UI strings go into the `I18N` dictionary (en/ja/zh/ko) in `extension.ts`; English is the source of truth.
- If you change loader behavior, run `node scripts/verify-secondary-merge.js` and check it still passes against your data.

## Reporting bugs

Session data is private — **never paste raw `.jsonl` contents** into an issue. Describe the record shape (types, flags) instead, or share a minimal anonymized reproduction.
