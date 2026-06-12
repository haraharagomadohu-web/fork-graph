# 参考資料: Claude Code for VS Code 拡張の実物コード

> Anthropic 公式拡張 **Claude Code for VS Code (`anthropic.claude-code`)** の
> インストール済みファイルを、本プロジェクト（Fork Graph 拡張）の参考資料として複製したもの。
> 「拡張をどう作るか」を**公式の実装から逆引き**するために置いている。
>
> 取得元: `~/.vscode/extensions/anthropic.claude-code-2.1.163-win32-x64/`
> バージョン: **2.1.163** / 取得日: 2026-06-05
>
> **注意: `source/` フォルダはプロプライエタリ製品の複製のため `.gitignore` 済み**で、
> 公開リポジトリには含まれない。手元で参照したい場合は、上記の取得元
> （自分の VS Code 拡張インストール先）から `source/` へコピーすること。
> 以下の解説のコード引用は、その複製が手元にある前提で行番号を示している。

---

## ⚠️ 前提と注意

- ここにあるのは **出荷物（shipped build）** であって、元の TypeScript ソースではない。
  `extension.js` / `webview/index.js` は **bundle + minify 済み**で、変数名は `B` `w` `u` 等に潰れている。
  「何をしているか」は読めるが「綺麗な設計」は読めない。
- Claude Code は **プロプライエタリ製品**（`package.json` の license 参照）。
  これは個人の学習・参考目的でローカルに展開されたものを見ているだけ。再配布はしない。
- セッションファイル形式と同様、拡張の内部構造も **非公開 API**。将来のバージョンで変わりうる。

---

## ファイル早見表

| ファイル | 中身 | 私たちにとっての価値 |
|---------|------|--------------------|
| [source/package.json](source/package.json) | 拡張マニフェスト | **最重要**。コマンド・activation・設定・貢献点が綺麗に読める |
| [source/extension.js](source/extension.js) | 拡張本体（2.1MB, minified） | パネル生成・CLI起動・コマンド登録の**実コード**。grep で部分的に読む |
| [source/webview/index.js](source/webview/index.js) | Webview 側 UI（4.8MB, minified） | Webview の作り込み。MVP5 で参考。今は深追い不要 |
| [source/webview/index.css](source/webview/index.css) | Webview スタイル | 同上 |
| [source/.vsixmanifest](source/.vsixmanifest) | VSIX パッケージのメタ | パッケージ化の実例 |
| [source/claude-code-settings.schema.json](source/claude-code-settings.schema.json) | `settings.json` のスキーマ | 直接は使わないが設定設計の参考 |
| [source/original-README.md](source/original-README.md) | 公式 README | 参考 |

> `extension.js` は巨大な1ファイルなので、**Read で全部開かず grep で必要箇所だけ**抜くのが正解。
> 本ドキュメントの抜粋もすべて grep で取得している。

---

## 1. MVP0 に効く: エディタ領域への Webview パネル生成

`extension.js` 内の実コード（整形して引用）:

```js
createWebviewPanel(
  "claudeVSCodePanel",   // パネルの型ID（activationEvents の onWebviewPanel:～ と対応）
  "Claude Code",         // タブのタイトル
  n,                     // ViewColumn（どの列に開くか）
  {
    enableScripts: true,            // Webview内で JS を動かす（グラフ描画に必須）
    retainContextWhenHidden: true,  // タブを隠してもDOM状態を保持（再描画コスト回避）
    enableFindWidget: true,         // Ctrl+F 検索を有効化
    localResourceRoots: [Uri.joinPath(this.extensionUri, "webview")]  // 読込許可フォルダ
  }
)
```

**私たちの MVP0 はこれをほぼなぞればよい。** 「エディタ領域に開く」要件は、この
`createWebviewPanel(..., ViewColumn, ...)` 形式（= WebviewPanel 方式）で満たされる。
`package.json` 側で `activationEvents: ["onWebviewPanel:claudeVSCodePanel", ...]` を
宣言しているのも対応関係として要記憶。

### CSP（Content-Security-Policy）の実例

公式の Webview HTML に埋まっている CSP（テンプレート版）:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{{NONCE}}'; img-src data:;">
```

- `default-src 'none'` … 既定で全部禁止（最も安全な土台）
- `script-src 'nonce-{{NONCE}}'` … **nonce を発行したスクリプトだけ実行許可**。
  ロード毎にランダム nonce を生成し、`<script nonce="...">` と CSP の両方に差し込む定石。
- `img-src data:` … data URL 画像のみ許可
- `style-src 'unsafe-inline'` … インラインCSSを許可（実運用は nonce 化が望ましいが公式はこれ）

**MVP0 で Webview に minimal HTML を埋め込むとき、このCSPをそのまま流用できる。**
prototype-minimal は外部依存ゼロ・インラインなので、nonce を1つ振れば動く。

### 外部アセットの読み込み方（MVP5 で使う）

公式は HTML 直書きではなく `webview/index.js` / `index.css` を**外部ファイルとして読み込む**:

```js
// ローカルファイルを Webview から参照可能な URI に変換
webview.asWebviewUri(Uri.file(this.context.asAbsolutePath(r)))
```

`localResourceRoots` で許可 → `asWebviewUri` で URI 変換 → HTML に `<script src>` 差し込み、が定石。
MVP0 はインライン直書きで十分だが、**MVP5 で full UI を移植して肥大化したらこの方式に移行**する。

---

## 2. コマンド登録パターン

`package.json` の `contributes.commands` で宣言し、`extension.js` の
`activate()` 内で `registerCommand` する、という2段構え。

宣言（[source/package.json](source/package.json) L148〜）の例:
```json
{ "command": "claude-vscode.editor.open", "title": "Claude Code: Open in New Tab" }
```

実装（extension.js）の例:
```js
registerCommand("claude-vscode.editor.open", ...)
registerCommand("claude-vscode.editor.openLast", ...)
registerCommand("claude-vscode.reopenClosedSession", ...)
```

**私たちの MVP0** はこれの最小版:
`package.json` に `{ "command": "fork-graph.open", "title": "Fork Graph: Open" }` を宣言し、
`activate()` で `registerCommand("fork-graph.open", () => createWebviewPanel(...))`。

### 配置の選択肢（公式は3つ持っている）

| コマンド | 配置 | 対応 API |
|---------|------|---------|
| `claude-vscode.editor.open` | **エディタ領域（タブ）** | `createWebviewPanel` ← **私たちが使う** |
| `claude-vscode.sidebar.open` | サイドバー | `registerWebviewViewProvider` + `contributes.views` |
| `claude-vscode.window.open` | 別ウィンドウ | 〃 + 新ウィンドウ |

公式は設定 `claudeCode.preferredLocation`（`sidebar` / `panel`）で切替可能にしている。
**私たちは editor だけでよい**ので、sidebar 系の `viewsContainers` / `views` 宣言は不要。

---

## 3. MVP3 に効く: セッション再開は「CLI フラグ」で行われている

最大の発見。`extension.js` は、特定セッションを開く公開コマンドを持たず、
**内部で Claude CLI を起動する際に引数を push** している。実コード:

```js
if (b) B.push("--continue");
if (w) B.push("--resume", w);                 // w = 再開するセッションID
if (this.options.forkSession) B.push("--fork-session");
if (this.options.resumeSessionAt) B.push("--resume-session-at", this.options.resumeSessionAt);
```

ここから読み取れる事実:
- セッション再開は **`claude --resume <sessionId>`**
- Fork は **`--fork-session`**（resume と組み合わせる）
- 特定メッセージ地点からの再開は **`--resume-session-at <uuid>`**

### ★追補（2026-06-05 再調査）: エディタ領域で特定セッションを開くコマンドは「ある」

当初「UUID指定で開く公開コマンドは無い」と書いたが、`extension.js` を読み直したところ
**`claude-vscode.editor.open` が `sessionId` を引数に取り、エディタ領域に開ける**ことを確認した。
これは公開ドキュメントには無いが、`registerCommand` 済みで他拡張から `executeCommand` で呼べる。

```js
// 公式のコマンド登録（editor.open は ViewColumn も受ける）
registerCommand("claude-vscode.editor.open", async (h,_,b) => {
  ...
  createPanel(h, _, b);   // h=session参照, b=ViewColumn
})
// createPanel(e,t,r): e があれば sessionPanels.get(e) でそのセッションのパネルを再利用/生成
createPanel(e,t,r){ if(e){ let a=this.sessionPanels.get(e); ... } ... }

// 公式自身がこう呼んでいる（= sessionId 指定でエディタ領域に開く実例）
executeCommand("claude-vscode.editor.open", e.request.sessionId, void 0, ViewColumn.Active)
```

**私たちの MVP3 はこれをそのまま呼ぶ**:

```js
await vscode.commands.executeCommand(
  "claude-vscode.editor.open",
  sessionId,                 // 該当 .jsonl のファイル名 UUID
  undefined,                 // initialPrompt
  vscode.ViewColumn.Active   // エディタ領域
);
```

- 粒度は **`sessionId` 単位**（ファイル単位）。`editor.open` は initialPrompt は取るが
  「メッセージ地点」での再開は受けない。地点単位は `--resume-session-at <uuid>`（CLIフラグ）でのみ可能で、
  これは将来拡張の課題。
- リスク: 非公開コマンドなので公式拡張の導入前提＆バージョン変更リスクあり。
  `vscode.extensions.getExtension('anthropic.claude-code')` で存在確認し、
  未導入時は CLI `claude --resume <id>`（上記フラグ）へフォールバックする。
- 上の「CLIフラグ」節は、公式の**ターミナルモード**や `--fork-session` / `--resume-session-at` の
  根拠として引き続き有効（拡張連携が使えない場合のフォールバック経路）。

---

## 4. その他メモ

- `activationEvents`: 公式は `onStartupFinished` で常時起動 + `onWebviewPanel:claudeVSCodePanel` で
  パネル復元時にも起動。**私たちは最小なら `onCommand:fork-graph.open` だけでよい**
  （コマンドが呼ばれた時だけ起動 = 軽い）。
- `capabilities.untrustedWorkspaces.supported: false` … 信頼されたワークスペースのみ動作。
- `engines.vscode: "^1.94.0"` … 要求する VS Code 最低バージョン。私たちは手元の 1.121 に合わせる。

---

## 参照とロードマップの対応

| 本資料の節 | ロードマップの該当 |
|-----------|------------------|
| §1 パネル生成・CSP | [../ROADMAP.md](../docs/ROADMAP.md) MVP0 |
| §2 コマンド登録・配置 | MVP0（確定済み設計決定: エディタ領域） |
| §1 外部アセット読込 | MVP5（full UI 作り込み移植） |
| §3 CLI フラグ再開 | MVP3（セッション再開） |
