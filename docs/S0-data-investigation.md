# S0: 実データ調査スパイク — 結果記録

> ロードマップ [ROADMAP.md](ROADMAP.md) の **S0（実データ調査スパイク）** の実施記録。
> 目的: 実 `.jsonl` を開き、**セッション間の Fork 親子がどのフィールドで辿れるか**を確定する。
> 結論を先に: **Fork 親子は復元できる**（企画の前提は成立）。
>
> 実施日: 2026-06-05 / 対象: `~/.claude/projects/` のローカル実データ
> 対象バージョン: Claude Code 2.1.163
>
> ⚠️ **訂正（2026-06-08）**: 本書 §3/§4 の「Fork は親履歴を**同一 uuid のまま**コピーする」は誤りだった。
> 現行 v2.1.163 の Fork は **uuid も sessionId も remap（振り直し）** する（公式 Session Storage 仕様 ＋ 実測で
> ファイル間共有 uuid = 0 を確認）。Fork で保存されるのは **`timestamp`**。結合キーを timestamp へ据え替えた
> 再設計は [S1-timestamp-merge-design.md](S1-timestamp-merge-design.md) を参照。以降の記述は uuid 部分のみ読み替えること。

---

## 0. 結論サマリ

| 問い | 答え |
|------|------|
| セッションはどこに保存？ | `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`（1ファイル=1セッション） |
| Fork 親子は辿れる？ | **辿れる**。Fork 時に親履歴が子ファイルへ**同一 uuid でコピー**され、分岐後に新規追記される |
| 親子を見分ける鍵は？ | **同一プロジェクト内で uuid プレフィックスを共有する2ファイル**。共有が切れる点＝分岐点 |
| ノードの見出しは？ | **分岐後の最初の `user` 発話**（＝Fork した時に実際に打った言葉）。コンセプトと一致 |
| `isSidechain` は使う？ | **使わない**。これは subagent の sidechain 用で Fork とは無関係 |

→ 企画の生命線（PROTOTYPES.md §6.4 の不確実性）は**クリア**。MVP1 の実装に進める。

---

## 1. ディレクトリ構造（実物）

```
~/.claude/
├── projects/
│   └── <encoded-cwd>/                    例: c--Users-natum-Desktop-claude-app-fork-graph
│       ├── <session-uuid>.jsonl          ← 1ファイル = 1セッション（これが本体）
│       └── ...
├── sessions/
│   └── <pid>.json                        ← 別物。実行中プロセスのポインタ（268B）。使わない
└── history.jsonl                         ← 横断プロンプト履歴。今回は使わない
```

- ROADMAP の当初想定 `projects/<encoded>/sessions/<uuid>.jsonl` は誤りで、正しくは
  **`projects/<encoded>/<uuid>.jsonl`（`sessions/` サブフォルダは無い）**。
- `<encoded-cwd>` は cwd のパス区切りを `-` に置換したもの（例: `c:\Users\natum\Desktop\...` →
  `c--Users-natum-Desktop-...`）。大文字小文字や記号の扱いは要確認だが、各レコードに
  `cwd` フィールドが入っているので**フォルダ名に頼らず中身の `cwd` で判定可能**。

---

## 2. `.jsonl` レコードの構造

1行 = 1 JSON オブジェクト（追記専用ログ）。`type` で種類が分かれる:

| type | 意味 |
|------|------|
| `user` | ユーザー発話。**`message.content` に本文**。`prompt` 抽出元 |
| `assistant` | アシスタント応答 |
| `attachment` | 添付（ファイル参照など） |
| `file-history-snapshot` | ファイル状態スナップショット |
| `queue-operation` | 入力キュー操作 |
| `last-prompt` | 直近プロンプト |
| `system` | システムイベント |

### 共通の主要フィールド（`user` レコード例）

```
uuid           このレコードの一意ID
parentUuid     直前レコードのuuid（時系列の親子チェーンを形成。null=起点）
sessionId      所属セッション（= ファイル名のuuidと一致）
type           'user' / 'assistant' / ...
message        { role, content } 本文。content は文字列 or [{type:'text', text:...}] の配列
timestamp      ISO8601
cwd            作業ディレクトリ（フォルダ名より信頼できる所属判定）
gitBranch      gitブランチ名
version        Claude Code バージョン
entrypoint     'claude-vscode' など
permissionMode / promptId / promptSource / userType / isSidechain
```

### プロンプト本文の取り出し

`message.content` は **文字列**か **`[{type:'text', text:'...'}]` の配列**。
配列のときは `text` を結合する。実例で「ヤコビアンとは、位置と説明変数を…」が取れた。

---

## 3. Fork の記録方式（精密解剖）

唯一見つかった実 Fork ペア（プロジェクト `c--Users-natum-Downloads--------`）を解析:

| | 親 `c98929da` | 子 `5b2af9d8` |
|---|---|---|
| 行数 / uuid数 | 135 / 95 | 128 / 92 |
| 共有 uuid | **89**（子の先頭125レコードが親と一致） | 〃 |
| 分岐点 uuid | `d71a9808`（共有の最後 = 最後の共通祖先） | 〃 |
| 分岐後の最初の新規 | — | `user`「ヤコビアンとは…」, `parentUuid = d71a9808` |
| timestamp | 07:25〜13:25 | 07:25〜12:28（同起点で分岐） |

**メカニズム**:
1. Fork すると、親の履歴が **同じ uuid のまま** 子ファイルへ丸ごとコピーされる。
2. その後、子は分岐点以降に新規レコードを追記する。
3. 子の最初の新規レコードの `parentUuid` は、**分岐点の共有 uuid を指す**。

```
親 c98929da:  [共有0..88] → 親独自の続き(6)
子 5b2af9d8:  [共有0..88] → 子独自の続き(3)   ← d71a9808 から分岐
                    ↑ 89個コピー
```

> 補足: `parentUuid` が「別ファイルの uuid」を指すクロスファイル参照も成立していたが、
> uuid はコピーで両ファイルに存在するため、**検出は uuid プレフィックス共有（仮説B）を主軸**にするのが堅い。

---

## 4. Fork 検出アルゴリズム（MVP1 への設計指針）

プロジェクト（`<encoded-cwd>` フォルダ）単位で:

1. 配下の全 `.jsonl` を読み、各ファイルの **順序付き uuid リスト**を作る。
2. ファイル対ごとに**共有 uuid プレフィックス長**を測る。共有があれば Fork 関係。
3. **分岐点** = 共有が途切れる直前の uuid。**子の見出し** = 分岐後の最初の `user` 発話。
4. **親方向の決定**（要設計）: 子は「親の全プレフィックス＋独自の続き」を持つ。
   チェーン Fork（Fork の Fork）では、**最長プレフィックスを共有する相手が直近の親**。
5. **ルート** = 他ファイルと uuid 共有を持たない、または最初の `user` の `parentUuid` が null。

### 注意・残課題（MVP1 で詰める）

- **親方向ヒューリスティックの厳密化**: 「共有プレフィックス＋双方が独自に継続」のとき、
  どちらを親とするか（＝オリジナルか Fork か）の判定ルールを確定する。
- **`--resume` の挙動**: resume が同一ファイルに追記か別ファイル生成かを確認
  （別ファイル生成だと uuid 共有が出るため Fork と区別が要る）。
- **`/rewind` の表現**: 今回のサンプルには出なかった。別ファイルになるか要確認。
- **計算量**: ファイル対の総当たりは O(n²)。共有判定は「先頭 uuid の集合 hash」で枝刈り可能。
- **フォルダ名エンコードに依存しない**: 所属判定は各レコードの `cwd` を使う。

---

## 5. プロトタイプのフィールドとの対応（更新版）

PROTOTYPES.md §6.4 の対応表を、本調査の結果で更新:

| プロトタイプ | 実データの取得元（確定） |
|-----------|----------------------|
| `id` | `.jsonl` ファイル名の session-uuid（= `sessionId`） |
| `parent` | **uuid プレフィックス共有による Fork 検出**（§4）。`isSidechain` ではない |
| `prompt` | **分岐後の最初の `user` 発話**（Fork でないルートは最初の `user` 発話）の `message.content` |
| `lane` | アルゴリズムで自動計算（MVP2、PROTOTYPES.md §2.7 の原則A/B） |
| `pinned` / `memo` | 自前 DB（VS Code `globalState`）に session-uuid をキーで保存（MVP4） |

---

## 6. ROADMAP への反映事項

- S0 完了条件「`id` / `parent` / `prompt` をどのフィールドから組み立てるか確定」→ **達成**（§5）。
- MVP1（実データ読込）の実装は **§4 のアルゴリズム**を起点にできる。
- 当初の想定パス（`sessions/` サブフォルダ）の訂正を MVP1 に反映する。
