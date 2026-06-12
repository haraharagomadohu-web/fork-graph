# isMeta ノード除外（「Continue from where you left off.」対策）

> 対象コード: [src/sessionLoader.ts](../../src/sessionLoader.ts) の `buildGraphFromRecords()`
> 関連資料: [JSONL-FORMAT.md §2.1](../../../docs/JSONL-FORMAT.md)

## 概要

VS Code でセッションを開き直す（resume する）たびに、ハーネスが
「Continue from where you left off.」という `type: "user"` レコードを自動注入する。
これは人の発話ではないのに user ノードとしてグラフに表示され、

- ノイズ 1 個だけの孤立枝（例: README ノード直下の lone Continue）
- 枝の先頭に挟まるノイズノード（例: Continue → ロードマップでは…）
- 主レーン内に点在するノイズ（23 ノード中 6 個が Continue だった）

を生んでいた。

## 実装手順

### 1. `RawRecord` に `isMeta` フィールドを追加
- 目的: JSONL の生レコードからフラグを読めるようにする
- やること: `isMeta?: boolean` を追加

### 2. user ノード抽出に `isMeta` チェックを追加
- 目的: システム挿入をノード化しない
- やること: `buildGraphFromRecords()` の抽出ループの先頭で `if (d.isMeta) continue;`

## 判断理由

- **なぜ `NOISE_PREFIXES`（文字列前方一致）に足さないのか**:
  「Continue from where you left off.」はユーザーが手で同じ文を打つことも理屈上あり得るし、
  文言はバージョンで変わり得る。データ側が `isMeta: true` という構造化された目印を
  付けてくれているので、それを使うのが最も頑健。
- **なぜ既存の `isHarnessNoise` と並べて別チェックにするのか**:
  `isHarnessNoise` は「テキストの見た目」での判定、`isMeta` は「レコードの属性」での判定で
  役割が異なる。両方残すことで、フラグ無し時代の古いセッションにも文字列判定が効き続ける。

## 検証

- 主レーン（root「すべての5ファイル…」の木）: 23 → 17 ノード（Continue 6 個が消える）
- README 直下の「Continue だけの孤立枝」が消滅
- 「出ました。」の枝が「Continue → ロードマップ…」から「ロードマップ…」直結に変わる
