# Claude Code セッション `.jsonl` フォーマット 全解説

> Claude Code が `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` に書き込む
> セッションファイルの構造を、**実データ（`version: 2.1.163`）** と公式資料の両面から網羅した資料。
>
> Fork Graph の実装（[sessionLoader.ts](../fork-graph-ext/src/sessionLoader.ts)）が
> 何をパースし、何を除外し、なぜ「Fork はファイル間で uuid を共有しない」のかを理解するための土台。
>
> 関連: [S0-data-investigation.md](S0-data-investigation.md)（系譜復元の調査）/ [ROADMAP.md](ROADMAP.md)
>
> 作成日: 2026-06-08 / 更新: 2026-06-11（§5 を再調査結果で訂正: Fork は「アクティブパスのみ」をコピーし、
> **fork 地点の末端 1 件は timestamp が再スタンプされる**。詳細は [S1 §10](S1-timestamp-merge-design.md)）
> / 調査対象バージョン: `2.1.163`

---

## 0. 全体像 — 2階層・2系統のモデル

`.jsonl` は **「1行 = 1 JSON オブジェクト = 1レコード」** の append-only ファイル。
各レコードは2層構造を持つ。

- **エンベロープ層**（共通メタ）: `type` / `uuid` / `parentUuid` / `timestamp` / `sessionId` / `cwd` など、
  どのレコードにも付く外側の封筒。
- **ペイロード層**: `message`（会話本体）や `attachment`（フック出力）など、`type` ごとに異なる中身。

さらにレコードは2系統に分かれる。

| 系統             | 持つもの                       | 役割                                                       |
| ---------------- | ------------------------------ | ---------------------------------------------------------- |
| **DAGノード**    | `uuid` + `parentUuid` を持つ   | 会話の系譜を構成（`user` / `assistant` / `attachment` / `system`） |
| **メタレコード** | `uuid` / `parentUuid` を持たない | 状態・索引・スナップショット（`mode` / `queue-operation` / `file-history-snapshot` / `last-prompt`） |

### 実データに出現する全8タイプ（version 2.1.163）

```
assistant              941   ← Claude の応答（DAGノード）
attachment             677   ← フック/IDE 等の自動挿入（DAGノード）
user                   450   ← ユーザー発話・tool_result 差し戻し（DAGノード）
mode                   143   ← 権限モード切替の記録（メタ）
file-history-snapshot  120   ← ファイル変更スナップショット（メタ）
last-prompt            115   ← 末尾プロンプトの索引（メタ）★旧 summary 相当
queue-operation         88   ← プロンプト投入キューの操作ログ（メタ）
system                  49   ← フック実行結果・compact 通知など（DAGノード）
```

> **版による揺れに注意**:
> - ブログ等で説明される `summary`（`leafUuid` 付きの会話タイトル）は、この版では **`last-prompt`** に置き換わっている。
> - `result` 型（セッション完了サマリ）はこの版のファイルには出現しない。
> - `mode` / `queue-operation` は新しめのタイプで、古い資料には載っていない。

---

## 1. 共通エンベロープ・フィールド

DAGノード（`user` / `assistant` / `attachment` / `system`）が共通して持つ封筒部分。

| フィールド    | 例                              | 意味                                                                   |
| ------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `type`        | `"user"`                        | レコード種別                                                           |
| `uuid`        | `"dca7caef-…"`                  | **このレコード固有の ID**。他レコードが `parentUuid` で参照する先       |
| `parentUuid`  | `"7b452fa4-…"` / `null`         | **直前レコードの uuid**。`null` = 会話の起点。これが DAG（系譜）を作る   |
| `timestamp`   | `"2026-06-05T05:40:38.978Z"`    | ISO 8601（ミリ秒精度・UTC）。記録された時刻                             |
| `sessionId`   | `"041bc147-…"`                  | **所属セッション = 自分のファイル名 UUID**                              |
| `cwd`         | `"c:\\…\\fork-graph"`           | 実行時の作業ディレクトリ                                                |
| `gitBranch`   | `"HEAD"`                        | 当時の git ブランチ                                                     |
| `version`     | `"2.1.163"`                     | Claude Code のバージョン                                                |
| `isSidechain` | `false`                         | **true = subagent（サブエージェント）由来**。メイン会話と別系統         |
| `userType`    | `"external"`                    | 通常ユーザーは `external`、Anthropic 社員は `ant`                       |
| `entrypoint`  | `"claude-vscode"`               | 起動経路（CLI / VS Code 拡張など）                                      |
| `slug`        | （一部のみ）                    | セッションの短い識別ラベル                                              |

---

## 2. DAGノード（系譜を作る4タイプ）

### 2.1 `user` — ユーザー発話 / tool_result の差し戻し

```jsonc
{
  "type": "user",
  "uuid": "dca7caef-…",
  "parentUuid": "7b452fa4-…",
  "promptId": "6ad2b98f-…",          // 投入プロンプトの識別子（★Fork コピー後も保存される安定 ID）
  "message": { "role": "user", "content": [ { "type": "text", "text": "..." } ] },
  "promptSource": "sdk",              // 投入元
  "permissionMode": "default",
  "toolUseResult": { ... },           // ★これがある = ツール出力の差し戻し（人の発話ではない）
  "sourceToolAssistantUUID": "…",     //   どの assistant の tool_use への応答か
  "isMeta": true,                     // ★システム的な挿入（人の発話ではない目印）
  "isCompactSummary": true,           // /compact の継続サマリ
  // …共通エンベロープ
}
```

**重要**: `type: "user"` でも「人が打った言葉」とは限らない。

- `toolUseResult` を持つもの（実データで 343/450 件）は **ツール実行結果の差し戻し**。
- `isMeta`（15 件）は **システム挿入**。
- `content` が `tool_result` ブロックだけのものも人の発話ではない。

→ Fork Graph が [sessionLoader.ts](../fork-graph-ext/src/sessionLoader.ts) の `isOnlyToolResult` /
`isHarnessNoise` / **`isMeta` チェック**でこれらを除外し、「Fork で実際に打った言葉」だけをノード化しているのはこのため。
（✏️ 2026-06-11: 当初の実装は `isMeta` を見ておらず、VS Code の再開時に注入される
「Continue from where you left off.」がノード化されて孤立枝やノイズノードを生んでいた。修正済み）

### 2.2 `assistant` — Claude の応答

```jsonc
{
  "type": "assistant",
  "uuid": "fe0b15f1-…",
  "parentUuid": "5a190631-…",
  "requestId": "req_011Cb…",          // API リクエスト ID
  "message": {
    "model": "claude-opus-4-8",
    "id": "msg_01M…",
    "role": "assistant",
    "content": [ /* content blocks（§4） */ ],
    "stop_reason": "tool_use",        // 停止理由（tool_use / end_turn …）
    "usage": { "input_tokens":…, "output_tokens":…, "cache_read_input_tokens":…, … }
  },
  // 稀に: isApiErrorMessage / error / apiErrorStatus（API エラー時）
  // 稀に: attributionMcpServer / attributionMcpTool（MCP 由来の応答）
}
```

1回の assistant ターンが **複数行に分かれる**ことがある（thinking → tool_use → text を別レコードで記録）。
`requestId` が同じものは同一 API 呼び出し。`requestId` / `message.id` は **Fork コピー後も保存される安定 ID**
（ただし 1 ターン複数行で共有されるため、単独では per-record キーにならない）。

### 2.3 `attachment` — フック / IDE 等の自動挿入物

```jsonc
{
  "type": "attachment",
  "uuid": "ae96b9be-…",
  "parentUuid": null,
  "attachment": {
    "type": "hook_success",           // hook_success / ide_opened_file 等
    "hookName": "SessionStart:startup",
    "hookEvent": "SessionStart",
    "content": "...", "stdout": "...", "stderr": "...",
    "exitCode": 0, "command": "...", "durationMs": 2381
  },
  // …共通エンベロープ
}
```

SessionStart フックの出力（claude-mem 連携の挿入文など）はここに入る。
DAGノードだが人の発話ではないので、グラフからは除外対象。

### 2.4 `system` — フック集計・compact 通知など

```jsonc
{
  "type": "system",
  "subtype": "stop_hook_summary",     // stop_hook_summary / compact_boundary 等
  "uuid": "d0f42413-…",
  "parentUuid": "72a05c27-…",
  "level": "suggestion",
  "hookCount": 1, "hookInfos": [...], "hookErrors": [], "preventedContinuation": false,
  "toolUseID": "…",
  // 稀に: logicalParentUuid / compactMetadata / content（compact 境界）
}
```

---

## 3. メタレコード（系譜を作らない4タイプ）

`uuid` / `parentUuid` を持たず、DAG には参加しない。状態管理・索引用。

### 3.1 `last-prompt`（★旧 `summary` 相当 / `leafUuid` を持つ）

```jsonc
{ "type": "last-prompt", "lastPrompt": "Fork Graphで…", "leafUuid": "5a190631-…", "sessionId": "041bc147-…" }
```

`leafUuid` = その時点の **会話の末端（leaf）レコードの uuid** を指す。
「セッションの今の先端はここ」という索引。公式ブログの `summary` / `leafUuid` の役割を、この版ではこれが担う。

> ⚠️ **先端ズレ（再開事故）**（2026-06-11 実測 / d8b477e8）: 同じセッションを複数のパネル/ウィンドウが
> 同時に開くと、各ビューが**自分のメモリ上の先端**に追記するため、古い先端に新しい発話が接続され、
> 本来の先端側の枝が dead fork 化することがある（巻き戻し操作なしで発生）。証拠はファイル末尾の
> `last-prompt` の交錯（古い leaf を指す索引が、新しい会話より後に書かれる）。append-only DAG なので
> エラーにはならず、静かに枝分かれとして残る。

### 3.2 `mode` / `queue-operation` / `file-history-snapshot`

```jsonc
{ "type": "mode", "mode": "normal", "sessionId": "…" }                                  // 権限モードの切替記録
{ "type": "queue-operation", "operation": "enqueue", "timestamp":"…", "sessionId":"…" } // プロンプト投入キュー操作
{ "type": "file-history-snapshot", "messageId": "dca7caef-…",                           // どの message 時点の
  "snapshot": { "trackedFileBackups": {…}, "timestamp": "…" }, "isSnapshotUpdate": false } // ファイルバックアップか
```

`file-history-snapshot` の `messageId` は対応する `user` / `assistant` の `uuid` を指す（`/rewind` のファイル巻き戻しに使用）。

---

## 4. `message.content` のブロック構造

`user` / `assistant` の `message.content` は **配列**（`string` の旧形式もあり）。ブロック型は4種。

| ブロック      | 出現       | 中身                                                                       |
| ------------- | ---------- | -------------------------------------------------------------------------- |
| `text`        | 両方       | `{ "type":"text", "text":"..." }` 可視テキスト                             |
| `thinking`    | assistant  | `{ "type":"thinking", "thinking":"...", "signature":"..." }` 思考（署名付き） |
| `tool_use`    | assistant  | `{ "type":"tool_use", "id":"toolu_…", "name":"Read", "input":{…} }` ツール呼び出し |
| `tool_result` | user       | `{ "type":"tool_result", "tool_use_id":"toolu_…", "content":..., "is_error":false }` ツール結果 |

`tool_use.id` ⇄ `tool_result.tool_use_id` で対応する。

---

## 5. 系譜（DAG）の再構成と Fork/Resume の挙動

- 会話は **`uuid` ⇄ `parentUuid` のポインタ**で繋がる有向非巡回グラフ（DAG）。
  `parentUuid: null` が起点、`last-prompt.leafUuid`（旧 `summary.leafUuid`）が末端。
- 順序非依存: ファイル内の行の並び順は本質的でなく、`uuid` / `parentUuid` から系譜を再構成できる。

### 5.1 Resume と Fork は別物（★Fork Graph 設計の最重要ポイント）

| 操作                          | uuid                | sessionId | ファイル              | 履歴の複製           |
| ----------------------------- | ------------------- | --------- | --------------------- | -------------------- |
| `--continue` / `--resume`     | **保つ**            | 保つ      | 同じファイルに追記    | しない（DAG 共有）   |
| `--fork-session` / VS Code「Fork conversation from here」 | **新規に remap** | **新規** | 別ファイルを新規作成 | **する（分岐点までのアクティブパスのみ）** |

> ✏️ 訂正（2026-06-11）: 複製は「全コピー」ではない。コピーされるのは **fork 地点に至る DAG パス上のレコードだけ**で、
> オリジナル側で放棄された行き止まり分岐（公式 CHANGELOG の言う **dead-fork entries**）はコピーされない。
> また旧記述にあった `/branch` は、セッション内分岐（`/rewind` 系）と新ファイル Fork を混同していたため削除。

公式仕様（[code.claude.com docs](https://code.claude.com/docs/en/agent-sdk/sessions)）の `forkSession`:

> The `forkSession` function creates a new session by reading source entries,
> **rewriting session IDs, and remapping message UUIDs**.
> It then appends these transformed entries under a new key.

### 5.2 実データで裏付けられた Fork の挙動（version 2.1.163）

| 検証                                | 結果                                            | 意味                          |
| ----------------------------------- | ----------------------------------------------- | ----------------------------- |
| 各レコードの `sessionId`            | **必ず自分のファイル名と一致**                  | Fork 時に振り直される         |
| ファイル間で共有される `uuid`       | **0 個**（14 ファイル時点でも再確認）           | uuid での結合は不可能         |
| ファイル間で共有される `timestamp`  | **438 個**（14 ファイル時点。10 ファイル時点では 388 個。715448d0 ↔ d8b477e8 は 346 個） | timestamp は保存される |
| Fork ファイル側の共有レコード       | **例外なく連続した先頭プレフィックス**（5 ファイルすべてで穴 0） | コピーは分岐点までのパスを先頭にまとめて書く |
| オリジナル側の共有領域              | 行き止まり分岐（dead-fork entries）が**介在**（d8b477e8 では 91 件） | Fork はアクティブパスのみコピーする |
| **fork 地点の末端 1 件**            | **内容・`requestId`・`message.id`・`usage` は一致するが timestamp だけ Fork 作成時刻**（5/5 ファイルで再現） | **timestamp 保存には例外がある** |

→ **`timestamp` がコピー元のまま保存される**（末端 1 件を除く）ことが鍵。これが（remap される）`uuid` に代わる
**ファイル間 Fork の結合キー**になる。

### 5.3 結合キーとしての `timestamp`（誤検出への耐性と限界）

| ケース                          | timestamp の挙動                              | 判定                       |
| ------------------------------- | --------------------------------------------- | -------------------------- |
| 真の Fork（履歴コピー）         | コピー元と **完全一致** する timestamp が大量に並ぶ | 同一ノードとして統合       |
| 手動でプロンプトを流用した別会話 | 新規送信なので **新しい timestamp**            | 別の木として正しく分離     |
| **fork 地点の末端 1 件**        | **再スタンプされ一致しない**（例外）           | 畳まれず重複し得る（[S1 §10.2](S1-timestamp-merge-design.md)） |

ミリ秒精度の timestamp が大量に一致するのは複製コピー以外あり得ないため、
「最初のプロンプトの手動流用」のような偽の一致と確実に区別できる。ただし注意点が 2 つ:

- **timestamp 単独では結合キーにならない**。同一ミリ秒に複数レコードが普通に存在する
  （thinking / text の分割書き込み、並列ツールの同時拒否など）。`type`＋内容 fingerprint との併用が必須。
- **「連続して一致」はファイルの行順の話としては不正確**。Fork ファイル側では連続プレフィックスだが、
  オリジナル側では dead-fork entries が間に挟まるため一致レコードは飛び飛びに現れる。
  正しくは「**DAG パス上で**一致が連なる」。
- timestamp が再スタンプされる末端 1 件には、Fork でも保存される安定 ID（user の `promptId`、
  assistant の `requestId` / `message.id`）による二次結合で対処できる（[S1 §10.3](S1-timestamp-merge-design.md)）。

### 5.4 Resume による履歴の再シリアライズ追記（2026-06-11 発見）

`claude --resume <id>` は条件によって（少なくとも fork/compact を経た系譜のセッションで）、
**会話の完全な論理履歴をファイル末尾に再シリアライズして追記**することがある。実測（715448d0）:

| 性質 | 実測値 |
| --- | --- |
| 追記されたレコード | 452 件（元 702 件のファイルに対し） |
| `uuid` | **すべて新規**（元レコードと共有 0） |
| `timestamp` | **当時のまま保持**（450/452 が既存レコードと同一 ms） |
| `sessionId` | 自ファイルに統一 |
| ブロック分割 | 「自動添付＋本文が同居する 1 レコード」を**個別レコードに分割**して書く |

**含意**:

- 同一発話が「合体版（旧形式）」と「分割版（再シリアライズ後）」の両形式で同一ファイル/系譜に共存し得る。
  Fork Graph は user 指紋を**発話本文ブロック基準**に正規化して両者を畳む（`fingerprint()`、
  [block-level-text-extraction.md](../fork-graph-ext/docs/implementation/block-level-text-extraction.md)）。
- `user` レコードの `message.content` は配列で、**自動添付ブロック（`<ide_opened_file>` 等）と
  人の発話ブロックが同居する**ことがある。先頭ブロックだけでノイズ判定すると実プロンプトを取りこぼす
  （Fork Graph で実際に多数欠落していた既知バグ。ブロック単位判定に修正済み）。
- canonical 化（timestamp+type+内容）はこの再シリアライズに対しても頑健で、実測では 452 件中
  約 440 件が既存ノードへ正しく併合された。

---

## 6. Fork Graph 実装への含意

- S0 調査時の前提「Fork 時は親履歴が**同一 uuid のまま**子ファイルにコピーされる」は、
  **現行版（2.1.x）では成り立たない**。Fork は uuid も sessionId も振り直す。
- 旧実装（`parseJsonlInto`）は **uuid の重複排除でファイル間 Fork を統合する**設計だったが、
  共有 uuid が 0 のため一度も発動せず、複製された同一会話が別々の木として並ぶ／クリックで
  開くセッションが表示と乖離する、という 2 つのバグを生んでいた。
- ✅ 対応済み（2026-06-08）: ファイル間の結合キーを `uuid` → **`(timestamp + type + 発話内容)`** に変更した
  `canonicalize()` を [sessionLoader.ts](../fork-graph-ext/src/sessionLoader.ts) に実装し、
  共有プレフィックスを 1 組の canonical ノードに畳んで分岐点から枝分かれさせる方式に移行
  （設計は [S1-timestamp-merge-design.md](S1-timestamp-merge-design.md)）。
- ✅ 補修済み（2026-06-11）: **fork 地点の末端 1 件は timestamp が再スタンプされる**ため一次 key では
  畳まれないが、Fork でも保存される安定 ID（`promptId` / `requestId`）＋型＋内容＋親 key の一致による
  **二次結合**を `canonicalize()` に実装して併合（設計と検証は [S1 §10](S1-timestamp-merge-design.md)）。

---

## 付録: 調査に使ったコマンド

```bash
# レコード type 別の件数と、type ごとの全フィールド
python3 - <<'PY'
import json, glob
from collections import Counter, defaultdict
types=Counter(); keys=defaultdict(Counter)
for f in glob.glob("*.jsonl"):
    for line in open(f, encoding='utf-8'):
        if not line.strip(): continue
        try: d=json.loads(line)
        except: continue
        types[d.get('type')]+=1
        for k in d: keys[d.get('type')][k]+=1
PY

# ファイル間で共有される timestamp（= Fork の結合キー）の検出
# → 共有 uuid は 0、共有 timestamp は多数、が確認できる
```

---

## 参考資料

- [Claude Code Docs — Sessions / Session Storage](https://code.claude.com/docs/en/agent-sdk/sessions)（`forkSession` の uuid remap 仕様）
- [Messages as Commits: Claude Code's Git-Like DAG of Conversations（Piebald）](https://piebald.ai/blog/messages-as-commits-claude-codes-git-like-dag-of-conversations)
- [Inside Claude Code: The Session File Format and How to Inspect It（Medium）](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b)
