# MVP6+ — 言語選択・日時検索・復元プレビュー

> 対象コード: [src/extension.ts](../../src/extension.ts)
> 由来: ユーザー要望（2026-06-12）

## 概要

1. **言語選択**: UI 全文字列を辞書化（`I18N`）。**デフォルト英語**、日本語・中国語・韓国語を同梱。
   ☰メニューの Language セレクタで切替、`globalState`（`forkGraph.lang`）に保存して次回以降も維持。
2. **日時検索**: ヘッダーにカレンダー（`<input type="date">`、ダーク対応）。選んだ**ローカル日付**に
   発話されたノードだけがヒットし、それ以外は減光。テキスト検索と **AND 条件**で併用可。×で解除。
3. **ソフトデリートの復元プレビュー**: ☰メニューの復元リスト各行に「プレビュー」ボタンを追加。
   押すと**別タブ**（`ViewColumn.Beside`）に、その key を含む**木 1 本だけ**を同じ UI で表示する。

## 復元プレビューの仕様

| 項目 | 内容 |
| --- | --- |
| 表示範囲 | 対象 key を含むルート木 1 本（拡張側 `buildPayload(…, previewFocusKey)` でフィルタ） |
| 対象枝の可視化 | プレビュー内では対象 key をソフトデリート集合から外して**見える状態**にする（他のソフトデリートは隠したまま） |
| 接続位置の確認 | 対象ノードを**自動選択**＋`scrollIntoView`。対象枝（自身＋子孫）に accent 色のグロー（`.focus-branch`） |
| 中身の確認 | 右パネルの **Open in Claude Code** がそのまま使える（復元前でも開ける。公式削除済みなら CLI 経路） |
| 復元 | ヘッダーに「⤴ この枝を復元する」ボタン。押すと復元され、**メインパネルの表示・復元リストも自動更新** |
| 出さない機能 | ソフトデリートボタン・フォルダ選択・復元リスト（プレビューには不要のため非表示） |
| パネル管理 | focusKey ごとに 1 枚（再クリックは既存タブを前面化）。破棄で登録解除 |

## 実装の要点

- メッセージを `handleMessage()` に共通化し、メイン／プレビューの両パネルから同じプロトコルで
  `openSession / openSessionCli / saveNote / softDelete / restoreNode / switchProject / setLang / openPreview` を受ける。
- `softDelete` / `restoreNode` は globalState 更新後に **メインへ `postData`** — プレビューから復元しても
  メイン側のグラフと復元リストが即座に追随する。
- note バナーは文字列でなく `noteCode`（fallback/empty）で渡し、Webview 側で言語に応じて表示。
- 相対時刻（`relTime`）も辞書化（just now / たった今 / 刚刚 / 방금 など）。

## 判断理由

- **デフォルト英語**: 要望どおり。配布（Marketplace）を見据えると第一言語は英語が妥当。
- **日付は「ローカル日付の一致」**: timestamp は UTC 保存だが、ユーザーの体感（「あの日のチャット」）は
  ローカル時間なのでローカルに変換してから日付比較する。
- **プレビューを別 Webview パネルにした**: 要望（別タブ）どおり。メインと同じ HTML 生成器を
  `payload.preview` フラグで分岐させ、コードの二重管理を避けた。

## 検証

- `npm run redeploy` 成功（45.6KB）。言語切替・日付検索・プレビューの操作感は実機確認待ち。

---

## 追補（2026-06-12 第2弾）— 時刻検索・i18n 漏れ修正・別フォルダのチャットを開く

### 1. カレンダーを自前実装に置き換え＋時刻検索

- **問題**: 内蔵 `<input type="date">` の「年/月/日」表示とカレンダーポップアップは
  **ブラウザ（VS Code）のロケール固定**で、拡張内の言語切替に追従できない。
- **対処**: 月名・曜日を `Intl.DateTimeFormat`（en-US/ja-JP/zh-CN/ko-KR）で生成する
  **自前カレンダー**に置き換え。言語切替で即座に表記が変わる。
  - おまけ: **チャットが存在する日に ● マーカー**（探す目的に直結）
  - 同じ日を再クリックで選択解除。ヘッダーのボタンに現在のフィルタ（日付＋時間帯）を表示
- **時刻検索**: カレンダー内に時刻範囲（from–to、`HH:MM` の辞書順比較）。日付と AND。
  日付未指定で時間帯だけの絞り込みも可（全日付横断）。

### 2. i18n 漏れ（フォルダ一覧の「〇日前」）

言語切替ハンドラが `renderProjectSelect()` を呼んでおらず、相対時刻が旧言語のまま残るバグ。修正済み。

### 3. 別フォルダのチャットが「新規チャット」になる問題

- **原因**: 公式拡張の resume は `SessionStore.load({projectKey, sessionId})` で
  **現在のワークスペースに対応するプロジェクトの中だけ**を探す。別フォルダの sessionId は
  読込失敗 → resume を黙って捨てて新規チャット（削除済みセッションと同じサイレントフォールバック）。
- **対処**: ペイロードに `foreign`（表示中フォルダ ≠ ワークスペース対応フォルダ）と
  `projectCwd`（実パス。`listProjects()` のラベル＝先頭レコードの cwd）を追加。
  foreign のとき Open ボタンは「▶ 別フォルダ — CLI で開く」になり、
  **そのフォルダを cwd にしたターミナル**で `claude --resume <id>` を起動する
  （CLI も cwd 由来の projectKey で探すため、cwd を合わせないと見つからない）。
  フォルダが既に存在しない場合は通常 cwd で起動にフォールバック。

### 4. Open 経路のトグルと CLI のエディタタブ化（2026-06-12 第3弾）

- **CLI で開くトグル**: 右パネルの Open ボタン直下にチェックボックスを追加。
  全ノードで「公式拡張で開く / CLI で開く」を選べる。選択は `globalState`
  （`forkGraph.openViaCli`）に保存され全ノード共通の好みとして維持。
  **削除済み・別フォルダのノードは CLI 固定**（チェック ON・無効化＋「このノードは CLI のみ」表記）。
- **CLI をエディタ領域の新規タブで開く**: `createTerminal` に
  `location: vscode.TerminalLocation.Editor` を指定。下部パネルではなく
  通常のタブとしてターミナルが開く（公式拡張で開いた場合と同じ場所感）。

### 5. /compact マーカー・Reload 復元・CLI デフォルト ON（2026-06-12 第4弾）

- **/compact の実行位置を 2 重波線で表示**: `/compact` は JSONL に
  `system/compact_boundary` レコード（`parentUuid: null`・`logicalParentUuid`＝圧縮直前の末尾）と
  `isCompactSummary: true` の user レコードを残す（実データ 2 件で確認）。
  - ローダー: `logicalParentUuid` で親鎖を橋渡し（放置すると /compact 以降がルート化して木が割れる）。
    境界の「直近 user 祖先 U の子のうち、境界以後で最初・同セッションの子」への辺を
    `GraphNode.compacted` としてマーク。次の発話が要約経由でぶら下がる形と、
    圧縮前末尾へ直接つながる形の 2 パターンを同じ規則で拾える。
  - Webview: 該当エッジの子ノード直前に、エッジを隠す帯＋2 本の波線（軸の省略記号 ≈）を交差描画。
    波線色はレーン色、tooltip と右パネルのバッジ（≈ compact）も付く。検索の減光に追従。
- **Developer: Reload Window 後もタブが消えない**: `WebviewPanelSerializer` を
  `forkGraphPanel` / `forkGraphPreview` の両 viewType に登録し、package.json に
  `onWebviewPanel:` activation events を追加。Webview は `vscode.setState()` に
  `{projectDir, focusKey}` を保存し、復元時はそこから `buildPayload` で建て直す
  （パネル生成と復元で `initMainPanel` / `initPreviewPanel` を共通化）。
- **CLI トグルのデフォルト ON**: CLI で Claude Code を使う人が多いため、
  `forkGraph.openViaCli` 未設定時の既定値を `true` に変更（配布時の初期状態が CLI 経路になる）。
  一度 OFF にすればその選択が保存される点は従来どおり。
