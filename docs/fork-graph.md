# Fork Graph — プロジェクト概要

> Claude Code の会話セッションが Fork で枝分かれしていく系譜を、
> git-graph 風のグラフで可視化する VS Code 拡張のアイデア。
>
> このドキュメントは **目的・痛点・コアコンセプト・差別化** をまとめたもの。
> プロトタイプの技術仕様は [PROTOTYPES.md](PROTOTYPES.md) を参照。

---

## 1. プロダクトの目的

Claude Code for VS Code を毎日使う開発者が、過去に **`/branch` / `/rewind` / `--fork-session`
で枝分かれさせた会話セッション** を、後日「あの良い状態のやつ」と素早く見つけて再開できるようにする。
そのために、Fork 系譜をグラフで可視化し、各ノードに **本人の主観メモ** を残せる拡張を作る。

---

## 2. 痛点

- Claude Code (VS Code 拡張) で **Fork 機能** をよく使う。
- 「コンテキストを読み込んだ **状態がいい**」と **感覚的に判断** したときに、その状態を保存したい。
- 翌日再開するときは Session history から探す。
- でも、いい状態の Session が history に溜まると、**Session のタイトルだけでは中身が分からない**。
- 結果: 「タイトル見る → 開く → 中身確認 → 違う → タイトルに戻る → 別のを開く」のループに陥る。

### 痛点の核心

「**感覚的判断**は残せているが、**判断の根拠**が残っていない」。
Fork = 状態は保存できる。でも「なぜいいと感じたか」「何が良かったか」が抜け落ちる。
翌日の自分は判断の根拠を持たないまま、タイトルだけで再評価を強いられる。

→ この **「判断の根拠」を保存し、視覚的に辿れる道具** を作るのがゴール。

---

## 3. コアコンセプト

### 3 つの核

1. **会話の Fork を可視化する**
   `/branch` `/rewind` `--fork-session` で枝分かれする会話系譜をグラフで見せる。
   既存ツール(Claude Code Graph 等)は subagent や tool call を描いているが、
   **会話の Fork** は未開拓領域。

2. **ノード = ユーザープロンプト本文(の先頭数文字)**
   タイトルや日時ではなく、**実際に打った言葉** を見出しにする。
   「あの時こう言ったやつ」で記憶を呼び戻せる。

3. **見た目は git-graph 風**
   分岐(と将来的な合流)を直感的に把握できるレイアウト言語。
   Claude Code Graph の git-graph-style は UI インスピレーションの源
   (ただし対象は別物=subagent)。

### 副次的に欲しいもの

- ノードに **★(ピン留め)** ・ **✎(主観メモ)** を付けられる
- **ノードクリック → Claude Code for VS Code 拡張が起動 → その Session を開く**
  (VS Code 内で完結する設計、外部ターミナル/CLI を開かない)

---

## 4. 既存ツールとの差別化

### 既存の VS Code 拡張(Claude Code セッション管理系)

| 拡張 | 特徴 | 強み |
|------|------|------|
| Claude Session Manager (LinMa) | 横断 browse/search/rename/可視化 | 軽量 |
| Claude Session Explorer (ShahadIshraq) | Explorerサイドバーから browse/resume | UI 統合 |
| **Claude Code and Codex Assist (agsoft)** | **履歴/差分/コスト/検索** + **ピン留め** + カスタムタイトル | 最強競合(6,939インストール) |
| Claude Code History (doorsofperception) | ローカル完結 browse/search | プライバシー |
| Codex History Viewer (hiztam) | browse/search + **タグ** + import/export | タグ機能あり |

### 既存にないもの(差別化軸)

1. **会話 Fork の git-graph 風可視化**
   - Session Atlas はトピック軸であって Fork 関係を描いていない
   - Claude Code Graph のブランチは **subagent spawn** であって会話 Fork ではない
   - **会話 Fork を git-graph 風に描く拡張は現状存在しない**

2. **長文の主観メモ(なぜ良いと思ったか)**
   - 既存はピン留め・タグ・カスタムタイトルなど **機械的な整理** のみ
   - **「なぜ良いと感じたか」を本文で書ける拡張は未提供**

### 公式機能との関係

Claude Code 公式に既に実装済み:
- `/branch [name]` / `/rewind` / `--fork-session` — 分岐操作
- `--resume <name>` / `/resume` — 再開
- **セッションピッカーで Fork 系譜のグループ展開表示**(`→` キーで展開)

未実装(Issue #32631 で提案、Open):
- `/branches` `/tree` `/switch` `/merge` `/checkpoint [name]` など

→ **データ(Fork系譜)は公式が提供している。差別化はビジュアル + 主観メモ**で出す必要がある。
公式の「ピッカーでのグループ展開」を超える価値(グラフUI + メモ)を提供することが本企画の役割。

---

## 5. 技術的見立て

### データソース

- Claude Code のセッションは `~/.claude/projects/<url-encoded-path>/sessions/<session-uuid>.jsonl` に保管
- 形式: JSON Lines (1行=1イベント、追記専用)
- フィールド: `type, uuid, parentUuid, timestamp, sessionId, cwd, gitBranch, version, message.content, message.usage`
- `parentUuid` でメッセージ親子を辿れる
- セッション間の Fork 関係(別 session-uuid 同士の親子)がどこに記録されているかは要実物確認
  (`isSidechain` フラグなどの可能性)

### 自前データ

- ピン留め (★) / 主観メモ (✎) は自前 DB(SQLite or JSON)に保存
- Session UUID をキーに紐付け

### 実装形態

- **VS Code 拡張**(TypeScript + VS Code Extension API)が最有力
- ノードクリック時のセッション再開は VS Code 拡張のコマンド経由
  (`vscode.commands.executeCommand` 等)

### リスク

⚠️ Claude Code のセッションファイル形式は **公式に安定APIとして提供されていない**。
将来のバージョンで形式が変わる可能性があり、互換性の考慮が必要。

---

## 6. 関連リンク

### 公式ドキュメント
- [Manage sessions](https://code.claude.com/docs/en/sessions)
- [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [VS Code extension - Resume past conversations](https://code.claude.com/docs/en/vs-code#resume-past-conversations)

### 公式 Issue
- [#32631 Conversation Branching (Open)](https://github.com/anthropics/claude-code/issues/32631) — Fork関連コマンドの提案

### 関連ドキュメント(本リポジトリ内)
- [PROTOTYPES.md](PROTOTYPES.md) — プロトタイプの技術仕様
- [prototype-minimal.html](prototypes/prototype-minimal.html) — 構造の最小確認版
- [prototype-full.html](prototypes/prototype-full.html) — 全機能体験版
- [sample-fork-graph.js](prototypes/sample-fork-graph.js) — サンプルデータ
