# MVP6 — 仕上げ・差別化機能

> 対象コード: [src/extension.ts](../../src/extension.ts) / [src/sessionLoader.ts](../../src/sessionLoader.ts)
> 仕様: [ROADMAP.md MVP6（2026-06-12 改定）](../../../docs/ROADMAP.md)

## 概要

6 機能を実装: ①検索ボックス ②★ピンフィルタ ③「いつ」表示 ④フォルダ選択
⑤ソフトデリート/復元 ⑥自動リロード。

前提として Webview を「**初期データ埋め込み＋`postMessage('data')` でいつでも差し替え可能**」な
構造に再編した（⑤⑥④が必要とするため）。UI 状態（選択・折りたたみ・ソフトデリート）は
ノード id（uuid。読み込みごとに変わり得る）ではなく**安定キー（node.key）**で保持し、
リロードやフォルダ切替をまたいでも壊れないようにした。

## 実装手順

### 1. データ差し替え基盤（applyData）
- 目的: ④⑤⑥がグラフの再構築を必要とするため
- やること: 拡張側 `buildPayload()`（nodes＋プロジェクト一覧＋ソフトデリート一覧＋hiddenSessions）
  → `postMessage({type:'data'})` → Webview `applyData()` が派生データ（byId/byKey/childrenOf/row）を再構築し再描画。
  選択は安定キーで復元、スクロールは graphEl を作り直さないことで自然に維持

### 2. 検索ボックス（ヘッダー）
- プロンプト＋メモを小文字比較でインクリメンタル検索。ヒット以外のノード・エッジに `.dim`（減光）。
  ヒット件数をボックス横に表示。**消さずに暗くする**のは位置＝系譜の文脈ごと見つけるため

### 3. ★ピン付きだけ表示（☰メニュー）
- ON 時は「ピン付きノード＋その祖先パス」の集合（`pinKeep`）だけ可視。
  非表示分はレーン圧縮（`laneMap` は可視ノードから計算）でコンパクトになる

### 4. 「いつ」の表示（右パネル）
- `GraphNode.timestamp` を追加（canonical 代表レコードの timestamp）。
  右パネルに `YYYY-MM-DD HH:mm（3日前）` 形式で表示。ノードの title ツールチップにも追加

### 5. フォルダ選択（☰メニュー）
- `listProjects()`: `~/.claude/projects/` 配下で `.jsonl` を持つフォルダのみ、最新 .jsonl の mtime で新しい順。
  **ラベルは最新 .jsonl の先頭レコードの `cwd`**（フォルダ名は encode 済みで実パスに戻せないため）。
  選択 → `switchProject` → 監視も張り替え

### 6. ソフトデリート / 復元
- 右パネルの「🗑 ソフトデリート」で**選択ノード自身＋子孫**を非表示（祖先ウォークで判定）。
- 保存は `globalState` の `forkGraph.softDeleted`（安定キー → プロンプト断片＋日時）。
  **`.jsonl` にも公式の `hiddenSessionIds` にも一切触れない**（Fork Graph 内だけの表示制御）
- ☰メニュー「非表示済みチャットから復元」に一覧（プロンプト断片）＋復元ボタン

### 7. 自動リロード
- `fs.watch(projectDir)` で `.jsonl` の変更を検知 → **600ms debounce** → `postData()`。
  フォルダ切替で張り替え、パネル破棄で解除
- **メモ入力中は適用を退避**（`pendingPayload`）し、textarea の blur 時に適用 — 入力消失を防ぐ

## 判断理由

- **fs.watch（ファイル監視）を採用、Hooks/SDK 不採用**: 拡張内で完結し配布が容易
  （ユーザー側の settings.json 設定が不要）。CLI/パネル/ツール実行などどの経路の追記も検知できる。
  トークン消費はどちらの方式も無し。Hooks の利点（プロンプト送信時だけ発火する精密さ）は
  debounce で実用上吸収できる
- **ソフトデリートは表示制御のみ**: データ破壊リスクゼロ。公式の「削除」（hiddenSessionIds）とは
  独立した概念として扱う（公式削除＝破線ピル＋CLI で開く、ソフトデリート＝グラフから消える）

## 検証

- `listProjects()`: 実データで 15 フォルダ・新しい順・実 cwd ラベルを確認
- 全 75 ノードに timestamp 付与を確認
- `npm run redeploy` 成功。6 機能の操作感・自動リロードは実機確認待ち
