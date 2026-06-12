# MVP5 — full UI 作り込み移植（prototype-full.html 準拠）

> 対象コード: [src/extension.ts](../../src/extension.ts) の `getWebviewHtml()`
> 参照元: [prototype-full.html](../../../docs/prototypes/prototype-full.html) / [ROADMAP.md MVP5](../../../docs/ROADMAP.md)

## 概要

MVP4 の素朴な下部バー UI を捨て、prototype-full.html の作り込み UI を実データ版へ忠実に移植した。
CSS（18 レーン色・accent/pin/memo 色）・レイアウト定数（PILL_H/ROW_H/CHAR_W 等）・
状態管理（collapsed/laneMap/previewChars）・render() の構成は**プロトタイプと同一**。

## 移植した機能

| 機能 | 内容 |
| --- | --- |
| 右パネル | クリックで選択 → 右に詳細（badges / Prompt 全文 / メモ / Open ボタン / × で閉じる） |
| ★ピン留め | ピル左上に ★。パネルの pin-toggle バッジで切り替え |
| ▼/▶ 折りたたみ | 分岐に関与するノードに表示。子孫を非表示＋本体 35% 透過＋破線スタブ |
| レーン圧縮 | 折りたたみで空いたレーンを詰めて再配置（laneMap）。SVG 幅も追従 |
| 文字数スライダー | ☰メニュー内 0〜10 文字。ピル幅・レーン幅が連動 |
| メタ表示 | Project 名 · sessions · nodes · forks |

## プロトタイプとの意図的な差分（実データ版に必要なもののみ）

1. **メモが編集できる**: プロトタイプは表示のみ。実装ではメモ欄を textarea にし、
   「メモを保存」/ Ctrl+Enter で MVP4 の `globalState` 永続化（`saveNote`）に接続。
   見た目（teal の左ボーダー）はプロトタイプの `.memo` を踏襲
2. **Open ボタンが本当に開く**: モック alert → `openSession`（公式拡張連携）
3. **「削除済み — CLI で開く」**（ROADMAP MVP5 追加仕様）:
   公式 UI で削除（非表示化）されたセッションを `state.vscdb` の `hiddenSessionIds` から
   best-effort 抽出（SQLite 依存を増やさず生バイトから JSON 断片を正規表現抽出）。
   該当ノードは破線ピル＋パネルに「削除済み」バッジ、Open ボタンは
   「削除済み — CLI で開く」になり、ターミナルで `claude --resume <id>` を起動
   （公式 editor.open は非表示セッションを黙って新規チャットにすり替えるため）
4. 補助としてノードの `<title>` ツールチップ（プロンプト＋メモ）を維持（MVP6 #2 の先行）

## 判断理由

- **MVP4 の下部バー方式を廃止した理由**: ユーザー指摘どおりプロトタイプの設計（右パネル）と
  異なっていたため。クリック＝選択はプロトタイプどおりで、開くのはパネルのボタンに一本化
  （MVP4 のダブルクリック開きは廃止）
- **state.vscdb の生バイト抽出**: sqlite ライブラリ追加はパッケージ肥大とビルド複雑化を招く。
  値がページ境界で分断されると取れないが、失敗時は空配列＝バッジが出ないだけで安全に劣化する

## 検証

- 実データで削除済み 3 セッション（`2589b6fc` 含む）の抽出一致を確認
- `npm run redeploy` 成功・インストール済み
- 完了条件「full プロトタイプと同じ操作感が実データの拡張上で再現」は実機確認待ち
