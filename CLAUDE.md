# Fork Graph — 開発ガイド（Claude Code 用）

Claude Code の会話セッションが `/rewind`（セッション内分岐）や
`--fork-session`・VS Code「Fork conversation from here」（セッション間 Fork）で枝分かれしていく
**Fork 系譜を git-graph 風に可視化する VS Code 拡張** のプロジェクト。
各ノードに本人の主観メモを残し、「あの良い状態のセッション」を後日素早く見つけて再開できるようにする。

ルートの README.md は人間（GitHub 訪問者）向け。開発に必要な情報はこのファイルと docs/ にある。

## ファイル/フォルダ構成

```
fork-graph/
├── README.md                     ← GitHub 訪問者向け（製品紹介）
├── CLAUDE.md                     ← このファイル（開発の入口・構成説明）
├── LICENSE                       ← MIT
├── CONTRIBUTING.md               ← 貢献ガイド
│
├── docs/                         ← 開発ドキュメント
│   ├── fork-graph.md             ← 【企画】目的・痛点・コアコンセプト・差別化
│   ├── PROTOTYPES.md             ← 【仕様】2つのプロトタイプの動作仕様と本実装への引き継ぎ
│   ├── ROADMAP.md                ← 【計画】段階的ロードマップ（S0〜MVP6＋追補。全実装済み）
│   ├── FEATURES.md               ← 【一覧】実装済み機能の簡潔なまとめ
│   ├── S0-data-investigation.md  ← 【調査】実 .jsonl 解析の記録（※uuid 共有前提は現行版で無効。S1 参照）
│   ├── S1-timestamp-merge-design.md ← 【設計】timestamp 結合によるファイル間 Fork 統合（現行アルゴリズム）
│   ├── JSONL-FORMAT.md           ← 【資料】セッション .jsonl フォーマット全解説（v2.1.163 実データ準拠）
│   └── prototypes/               ← 【試作】HTML 単体で動く UI プロトタイプ
│       ├── prototype-minimal.html ←  最小確認版（9ノード/3レーン・依存ゼロ）
│       ├── prototype-full.html   ←  全機能版（ピン留め/メモ/折りたたみ/右パネル等）
│       └── sample-fork-graph.js  ←  full 用サンプルデータ（36ノード/18レーン/4ルート）
│
├── fork-graph-ext/               ← 【本実装】VS Code 拡張本体
│   ├── README.md                 ←   Marketplace リスティング用（英語・ユーザー向け）
│   ├── src/sessionLoader.ts      ←   .jsonl 読込・canonicalize・グラフ構築
│   ├── src/extension.ts          ←   拡張本体＋Webview UI（i18n/検索/カレンダー等を内包）
│   ├── docs/implementation/      ←   実装記録（マイルストーンごとの手順・判断理由・検証）
│   └── scripts/                  ←   検証スクリプト（dump-forest / verify-secondary-merge）
│
└── reference-claude-code/        ← 【資料】公式拡張の解説（実装の逆引き用）
    ├── README.md                 ←   私たちの視点での解説（コード引用付き）
    └── source/                   ←   公式拡張 v2.1.163 の出荷物の複製
                                      ※再配布禁止のため .gitignore 済み（リポジトリには無い。
                                        必要なら手元の VS Code 拡張インストール先からコピーする）
```

## いま読むべき順番

1. [docs/fork-graph.md](docs/fork-graph.md) … 何を作ろうとしているか
2. [docs/FEATURES.md](docs/FEATURES.md) … 何が実装済みか（簡潔な全体像）
3. [docs/ROADMAP.md](docs/ROADMAP.md) … どう実装してきたか（各マイルストーンの判断理由）
4. [docs/JSONL-FORMAT.md](docs/JSONL-FORMAT.md) ＋ [docs/S1-timestamp-merge-design.md](docs/S1-timestamp-merge-design.md) … データの実態と同定アルゴリズム（中核）
5. [reference-claude-code/README.md](reference-claude-code/README.md) … 公式実装から得た具体的な作り方

## 開発の基本

- ビルド＋ローカル配備: `cd fork-graph-ext && npm run redeploy`（コンパイル → vsix 作成 → インストール）
- 実装したら `fork-graph-ext/docs/implementation/` に記録を残し、`docs/ROADMAP.md` に追補する慣習
- ノードの永続状態（メモ・ピン・ソフトデリート）は uuid ではなく**安定キー（canonical key の SHA-1）**で持つ。
  uuid は Fork・再読込で変わるため使ってはならない（詳細: docs/S1 §3a）
- セッションファイルへの書き込みは絶対にしない（読み取り専用。ソフトデリートも表示制御のみ）
