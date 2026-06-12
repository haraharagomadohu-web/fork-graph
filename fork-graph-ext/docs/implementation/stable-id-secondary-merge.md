# 安定 ID による二次結合（fork 地点の timestamp 再スタンプ対策）

> 設計の出典: [S1-timestamp-merge-design.md §10](../../../docs/S1-timestamp-merge-design.md)
> 対象コード: [src/sessionLoader.ts](../../src/sessionLoader.ts) の `canonicalize()`

## 概要

ファイル間 Fork の統合は「canonical key = `timestamp + type + 内容指紋`」で複製レコードを
1 ノードに畳むことで実現している。しかし実データ調査（2026-06-11）で、
**Fork コピーの末端 1 レコードだけは timestamp が Fork 実行時刻に再スタンプされる**ことが判明した
（内容・`requestId`・`message.id`・`usage` まで完全一致なのに timestamp だけ違う。全 5 Fork ファイルで再現）。

この 1 件は key が一致しないため畳まれず、canonical DAG 上に「同じ親を持つ内容同一の兄弟」として
重複する。fork 元が人間の user 発話だった場合、グラフに同じプロンプトのノードが 2 つ並んでしまう。

**対策**: timestamp が再スタンプされても Fork コピーで保存される「安定 ID」
（user レコードの `promptId`、assistant レコードの `requestId`）を使い、
一次結合（key 一致）で畳まれなかった複製を二次パスで併合する。

## 実装手順

### 1. `RawRecord` 型に安定 ID フィールドを追加

- 目的: JSONL の生レコードから `promptId` / `requestId` を読めるようにする
- やること: `promptId?: string`（user 用）と `requestId?: string`（assistant 用）を追加。
  あわせて `timestamp` のコメントに「末端 1 件は再スタンプされる」例外を追記

### 2. 一次パスの後に「安定グループ」を作る

- 目的: 「同一イベントの複製なのに timestamp 違いで別 key になったもの」を見つける
- やること: 各 canonical key を
  `安定ID + type + 親key + 内容指紋` でグループ化する。
  このグループ key が同じ＝「同じ親にぶら下がる・型も内容も安定 ID も同じ」レコード。
  timestamp 以外のすべてが一致するので、複製コピー以外ではグループが 2 件以上にならない
- 安定 ID が無いレコード（attachment / system / 古い形式の user 等）は**グループ化しない**
  （誤併合のリスクを避け、安全側に倒す。これらが fork 末端でも user ノードにならないため実害なし）

### 3. グループ内の複数 key を 1 つに併合（alias）

- 目的: 再スタンプされた複製を canonical 代表へ吸収する
- やること: グループ内に key が 2 つ以上あれば、**timestamp 最古の key を代表**にし、
  残りを `aliasOf` マップで代表へ向ける。出現セッション集合も代表側へ合流させる
- 最古を代表にする理由: 再スタンプは「Fork 実行時刻＝後の時刻」への書き換えなので、
  最古の timestamp がオリジナルの真の発生時刻。`order`（timestamp 昇順）の並びも正しくなる

### 4. 親 key の翻訳時に alias を解決する

- 目的: 併合された key を親に持つレコード（Fork ファイル側の続き）が、
  代表ノードへ正しくぶら下がるようにする
- やること: 2nd pass の `parentKey → canonicalId` 変換の前に `resolveKey()` で alias を辿る

## 判断理由

- **「timestamp キーを捨てて安定 ID キーに全面移行」しなかった理由**:
  安定 ID はレコード型によって有無がまちまち（attachment / system には無い）で、
  `requestId` は 1 ターン複数行で共有されるため単独では per-record キーにならない。
  一次結合（timestamp+type+内容）は実測で共有 464 キー・親不一致 0 件と健全なので、
  弱点の 1 点（再スタンプ末端）だけを二次パスで補修するのが最小・最安全。
- **併合条件に「親 key 一致」を含める理由**: 安定 ID と内容が偶然一致しても
  （例: 同じ promptId を持つ複数 tool_result）、DAG 上の位置が違えば別イベント。
  親まで一致して初めて「同一イベントの複製」と言える。
- **先勝ちではなく最古勝ちにした理由**: 代表の timestamp はソート順（`order`）に使われる。
  再スタンプ時刻（Fork 実行時刻）を採ると枝の並びが実際の会話順とずれる。

## 検証

`fork-graph-ext` で `npm run compile` が通ること。
実データ（本プロジェクト 14 ファイル）で森を表示し、ノード数が二次結合の分だけ
減るか同数（重複末端が user ノード化していなければ同数）であることを確認する。
