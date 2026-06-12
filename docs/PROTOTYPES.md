# Fork Graph プロトタイプ仕様書

> このドキュメントは、`ideas/prototype-minimal.html` と `ideas/prototype-full.html`
> の **動作仕様と設計意図** をまとめたものです。新しい Claude Code セッションが
> このファイルだけを読んでも、プロトタイプの全体像と本実装への引き継ぎ事項を
> 把握できるように書かれています。
>
> 関連ドキュメント:
> - `ideas/fork-graph.md` … プロダクトのコアコンセプトと発見プロセス
> - `ideas/sample-fork-graph.js` … 多大なサンプルデータ(full プロトタイプが使用)
>
> 作成日: 2026-06-04 / プロトタイプ最終形

---

## 1. 何のためのプロトタイプか

### 1.1 プロダクトの想定

VS Code 拡張 **Claude Code for VS Code** の上で動く、**会話セッションの Fork 系譜可視化ツール**。
Claude Code は `/branch` `/rewind` `--fork-session` により会話を枝分かれさせられるが、
分岐した過去セッションを横断して探索するUIは公式・サードパーティとも未開拓
(類似拡張は機械的なリスト/検索止まり)。本企画はそこを git-graph 風の
グラフ可視化で埋めることを狙う。

### 1.2 プロトタイプの位置づけ

**本実装(VS Code 拡張) ではなく、UI 感とインタラクションの確認用**。
依存ゼロの単一 HTML で動く。実際の Claude Code セッションデータ
(`~/.claude/projects/<encoded-path>/*.jsonl`) は読まず、
ハードコードしたサンプルデータで描画する。

### 1.3 2つの prototype の役割分担

| ファイル | データ | 用途 |
|---------|--------|------|
| `prototype-minimal.html` | データ直書き(9ノード/3レーン) | **構造の最小確認**。Fork tree が「ピル+エッジ」だけでどう見えるかを判定する用 |
| `prototype-full.html` | `sample-fork-graph.js` を読み込み(36ノード/18レーン) | **全機能体験**。ピン留め、メモ、折りたたみ、右パネル、設定メニューなどすべて入り |
| `sample-fork-graph.js` | - | full の検証用データ。多レーン・多Fork・孫レベルFork・複数ルートを含む |

minimal は **外部依存ゼロ**(`file://` でそのまま開ける)。
full は `sample-fork-graph.js` を `<script src>` で読み込むので、
Chrome/Edge の `file://` だと CORS で動かない場合がある。
その場合は VS Code の Live Server 拡張などで配信する。

---

## 2. 共通仕様(両プロトタイプで一致する部分)

### 2.1 データモデル

各ノード = 1つの会話セッション。本実装では Claude Code の session-uuid に対応する想定。

```js
{
  id: 'm1',         // 一意のID
  parent: 'm0',     // 親セッションのID(parent: null ならルート)
  lane: 0,          // 描画上のレーン番号(0-indexed)。後述の原則で人手割当
  prompt: '...',    // ユーザーが打った最初のプロンプト本文(全文)
  pinned: false,    // ★ ピン留め状態(full のみ使用)
  memo: '...',      // 主観メモ(full のみ使用、空文字なら未記入)
}
```

`row`(縦方向の位置)はデータには持たず、`row = parent.row + 1` で実行時に計算する
(ルートは row 0)。

### 2.2 レイアウト計算(描画定数)

```js
const PILL_H   = 24;   // ピル高(固定)
const PILL_W   = 56;   // ピル幅(minimal は固定。full は文字数で可変)
const LANE_W   = 80;   // レーン中心間の横幅(minimal 固定。full は pillW+24 で可変)
const ROW_H    = 56;   // 行間の縦幅(固定)
const MARGIN_X = 50;   // レーン0の中心 x
const MARGIN_Y = 30;   // 上マージン
```

座標計算:
```js
function pos(n) {
  return { x: MARGIN_X + n.lane * LANE_W, y: MARGIN_Y + n.row * ROW_H };
}
```

SVG サイズ:
```js
svgW = MARGIN_X + (numLanes - 1) * LANE_W + 100;
svgH = MARGIN_Y * 2 + maxRow * ROW_H + 20;
```

### 2.3 ノード描画("4文字テキストのピル")

ノードは **円ではなくテキスト入りピル**。これがプロダクトのUI言語の核。

```
  ┌─────────┐
  │  Reac   │   ← prompt.slice(0, 4)、レーン色で着色
  └─────────┘   ← rx=PILL_H/2(完全な角丸=ピル形)
```

- ピル枠線: `var(--lane-N)` (=系統の色)
- ピル内テキスト: 同じレーン色、`text-anchor: middle`、monospace フォント
- ピル背景: `var(--bg)` (=画面背景と同じ。透けて見える効果)

### 2.4 エッジ描画(親ピル下端 → 子ピル上端)

```js
const HALF_H = PILL_H / 2;
const py = cp.y + HALF_H;   // 親ピル下端
const cy = cc.y - HALF_H;   // 子ピル上端
```

**同じレーン同士** = 真っ直ぐな垂直線:
```
M ${cp.x} ${py} L ${cc.x} ${cy}
```

**異なるレーン同士** = git-graph 風のL字+曲線:
```
M ${cp.x} ${py}                                  // 親ピル下端から
L ${cp.x} ${elbowY - 10}                         // 親レーンを少し下に降ろす
Q ${cp.x} ${elbowY}, ${cp.x + (cc.x-cp.x)*0.3} ${elbowY}  // 子方向へ滑らかに曲げ
L ${cc.x} ${elbowY}                              // 子レーンまで水平移動
L ${cc.x} ${cy}                                  // 子ピル上端まで垂直
```

ここで `elbowY = py + (cy - py) * 0.5`(親と子の中間 y)。

### 2.5 レーン縦線

各レーンに薄い縦線(`opacity: 0.12`、`stroke: lane-color`)を引いて、
「ここがレーンの軸」を視覚的に示す。

### 2.6 レーン色

CSS カスタムプロパティで `--lane-0` 〜 `--lane-17` を定義。
minimal は `--lane-0` 〜 `--lane-3` のみ使用。

| Lane | Color | 意味(sample-fork-graph.js での割当) |
|------|-------|------------------------------------|
| 0 | `#4ec9b0` teal | main 系統 |
| 1 | `#c586c0` purple | auth(m3 Fork) |
| 2 | `#ce9178` orange | RTK |
| 3 | `#569cd6` blue | redux-saga(s2 Fork) |
| 4 | `#dcdcaa` yellow | RTK Query(s1 Fork) |
| 5 | `#4fc1ff` light blue | Zustand |
| 6 | `#f48771` red | Tailwind |
| 7 | `#b5cea8` light green | Framer Motion(t2 Fork) |
| 8 | `#d7ba7d` gold | CSS-in-JS(t1 Fork) |
| 9 | `#6796e6` steel | Vitest |
| 10 | `#b267e6` violet | snapshot(v2 Fork) |
| 11 | `#e672a6` pink | Playwright |
| 12 | `#ff8c00` orange2 | Performance |
| 13 | `#00ced1` cyan | route splitting(f2 Fork) |
| 14 | `#a8c5e0` pale blue | Lighthouse(f1 Fork) |
| 15 | `#c9b8a0` sand | backend(独立ルート) |
| 16 | `#9fb89e` sage | deploy(独立ルート) |
| 17 | `#d4a4ce` mauve | CI(独立ルート) |

### 2.7 レーン割り当ての原則(重要)

サンプルデータの `lane` 値は手で決めているが、本実装では自動アルゴリズム化が必要。
適用したルールは以下の2つ:

#### 原則A: 深い系統ほど親レーンに近接

> 「最もひ孫のひが多いところから優先して親に隣接」

末端までの深さが大きい系統(=長く続く本流)を、親レーンのすぐ隣に置く。
浅い系統(=単発の枝分かれ)は外側に押し出される。
これにより主流が綺麗に並び、補助的な系統は端に追いやられる。

#### 原則B: 同じ親レーンから複数Forkが出るときは「分岐遅い順」に内側

> 同じ親レーン X から複数の Fork が出るとき、親レーンに沿って下に降りた
> **最も深い row で枝分かれする Fork** を X+1 に置く。次に深い分岐点を X+2 に置く。

これは原則A の補強。例えば s1/s2 は同じ lane 2:
- `s1 → ss1`(row 3 で分岐)
- `s2 → sg1`(row 4 で分岐)

このとき `sg1` を lane 3(親隣)、`ss1` を lane 4 にする。
逆にすると `s2 → sg1` のエッジが `ss1-ss2` の縦エッジを横切ってしまう。

**水路の分岐と同じ動き**(下流の分岐ほど元の流れに近く出る)と覚えると直感的。

### 2.8 行(row)の重複と多Fork問題

同じ row に複数ノードが並ぶケース(`m1 → m2, t1, v1, f1` のように1つの親から複数Fork)では、
各エッジの `elbowY` が同じ y 座標になり、**水平移動部分のエッジが重なる**。

これは現状の実装の既知の限界。本実装では各 Fork ごとに `elbowY` を少しずつずらす
git-graph 系ツールの工夫を入れる必要がある。

---

## 3. `prototype-minimal.html` 仕様

### 3.1 目的

**「ピル + エッジだけで Fork tree が成立するか」を判定する最小確認版**。
本実装のコアの見え方が分かれば十分、というスタンス。

### 3.2 含む機能

- 4文字ピルの描画(`prompt.slice(0, 4)`)
- レーン縦線(うっすら)
- エッジ描画(同レーン直線、異レーン曲線)
- レーン色によるノード種別表現

### 3.3 削った機能(意図的に)

- ★ ピン留め(描画なし)
- ✎ メモ(描画なし)
- ▼/▶ 折りたたみ
- クリック動作(完全に静的表示、選択も発火もなし)
- ホバー効果
- 右パネル / 詳細表示
- ヘッダーのプロジェクト情報・統計
- データの `pinned` / `memo` フィールド(データから削除)

### 3.4 データ

ファイル内に直書き(9ノード、3レーン):

```
n1 (lane 0) "Reactの…"
├─ n2 (lane 0) "Reduxの…"
│  ├─ n3 (lane 0) "やっぱ…"
│  │  ├─ n6 (lane 0) "Conte…"
│  │  │  └─ n9 (lane 0) "useRe…"
│  │  └─ n7 (lane 2) "Zusta…"
│  │     └─ n8 (lane 2) "persi…"
│  └─ n4 (lane 1) "RTKに…"
│     └─ n5 (lane 1) "creat…"
```

### 3.5 起動

`file://` で直接開ける。外部依存なし。

---

## 4. `prototype-full.html` 仕様

### 4.1 目的

**コアコンセプトのほぼ全機能を実装した体験版**。
本実装に向けて、各機能のUI感とインタラクションを検証する。

### 4.2 含む機能(機能一覧)

| # | 機能 | UI要素 |
|---|------|--------|
| 1 | 4文字ピル + エッジ描画(共通仕様 §2) | SVG |
| 2 | ★ ピン留めバッジ | ピル上端左 |
| 3 | ▼/▶ 折りたたみトグル | ピル上端右 |
| 4 | 折りたたみ状態(薄暗化 + 短い点線スタブ) | ノード + SVG path |
| 5 | レーン圧縮(折りたたみ時) | SVG width 動的計算 |
| 6 | 右パネル詳細表示 | `<aside>` |
| 7 | ピン留めトグル(右パネル) | `.badge.pin-toggle` |
| 8 | × クローズボタン(右パネル) | `.close-btn` |
| 9 | Claude Code 起動ボタン(モック) | `.open-btn` |
| 10 | 右パネル非表示(未選択時) | `main.no-detail` |
| 11 | メニュートグル(☰) | `#menu-btn` |
| 12 | プロンプト表示文字数スライダー(0–10) | `#chars-slider` |
| 13 | ピル幅・レーン幅の動的可変 | レイアウト再計算 |
| 14 | ホバーで枠線太く | CSS `:hover` |
| 15 | ヘッダーのメタ情報(ノード数 / Fork数) | `#meta` |

### 4.3 ▼/▶ 折りたたみトグルの仕様

#### 4.3.1 表示条件(全ノードには付けない)

```js
function showToggle(n) {
  if ((childrenOf.get(n.id) || []).length >= 2) return true;   // 自分が分岐点
  if (n.parent && (childrenOf.get(n.parent) || []).length >= 2) return true; // 兄弟がいる
  return false;
}
```

つまり「Fork に関係するノード」のみ:
- 自分が複数の子を持つノード(分岐点)
- 兄弟がいるノード(=自分の親が複数子を持つ → 自分は分岐した枝の先頭)

**linear なノード**(子1人かつ兄弟なし)には ▼ なし。

#### 4.3.2 折りたたみ動作

▼ クリック → 以下が起きる:
1. そのノードを `collapsed` Set に追加
2. **そのノード自身は描画される**(`.collapsed-self` クラス、`opacity: 0.35` で薄暗く)
3. **そのノードの子孫はすべて非表示**(エッジも消える)
4. そのノードのピル下端から **長さ22pxの短い点線**(`stroke-dasharray: 3 3`)を伸ばす
5. ▼ が ▶ に切り替わる(再クリックで展開)

#### 4.3.3 可視性判定

```js
function isAncestorCollapsed(n) {
  let pid = n.parent;
  while (pid) {
    if (collapsed.has(pid)) return true;
    pid = byId[pid].parent;
  }
  return false;
}
```

祖先に1つでも collapsed がいれば、そのノードは描画しない。
自分自身が collapsed の場合は薄暗く描画する(可視のうち)。

### 4.4 レーン圧縮の仕様

折りたたみで非表示になったノードのレーンが空いたら、**そのレーンを詰めて
残ったレーンを左寄せ**する。SVG 横幅も連動して縮む。

```js
function recomputeLayout() {
  const visible = nodes.filter(n => !isAncestorCollapsed(n));
  const used = Array.from(new Set(visible.map(n => n.lane))).sort((a,b) => a-b);
  laneMap = new Map(used.map((lane, idx) => [lane, idx]));   // 元 lane → 圧縮後 index
  currentSvgW = MARGIN_X + Math.max(0, used.length - 1) * laneW + 100;
}
function pos(n) {
  const mapped = laneMap.get(n.lane) ?? 0;
  return { x: MARGIN_X + mapped * laneW, y: MARGIN_Y + n.row * ROW_H };
}
```

**レーン色は元の lane 番号で保持**(視覚的な系統識別が変わらない)。
SVG width の変動には `transition: width 0.2s` でアニメーション。

### 4.5 右パネル(`<aside>`)の仕様

#### 4.5.1 表示・非表示

```css
main { grid-template-columns: 1fr 360px; transition: grid-template-columns 0.2s; }
main.no-detail { grid-template-columns: 1fr 0; }
main.no-detail aside { display: none; }
```

ノードが未選択の間は `main.no-detail` クラスが付与され、右パネル完全非表示。
グラフが画面全幅を使う。

ノード選択時(`select(id)`)に `no-detail` クラスを外し、右パネルがスライドインする。
× クリック時(`deselect()`)に再付与でスライドアウト。

#### 4.5.2 右パネルの構成

```
× (右上)
SELECTED SESSION
[lane-N] [★ pinned / not pinned] [memo] [▶ collapsed]
PROMPT
<プロンプト全文>
メモ
<メモ本文 or "(まだメモなし)">
[ ▶ Open in Claude Code ]
```

#### 4.5.3 ピン留めトグル

```html
<span class="badge pin-toggle on|off">★ pinned | not pinned</span>
```

- `.on`: 金色(`--pin`)、不透明
- `.off`: 灰色(`--fg-dim`)、`opacity: 0.5` で薄暗い
- クリックで `n.pinned = !n.pinned` → `render()` → `select(id)` 再描画
- `transition: 0.15s` でスタイル変化が滑らか

**注意**: プロトタイプなのでリロードすると `n.pinned` の変更はリセットされる。
本実装では永続化が必要。

#### 4.5.4 Claude Code 起動(モック)

```js
onclick="alert('🎬 Claude Code for VS Code 拡張を起動します\\n→ session: ${n.id}\\n\\n(プロトタイプなのでモック動作)')"
```

本実装では `vscode.commands.executeCommand` で
Claude Code 拡張の resume コマンドを呼ぶか、CLI `claude --resume <id>` を起動する想定。

### 4.6 メニュー(☰)の仕様

#### 4.6.1 表示

ヘッダー右端のボタン(`#menu-btn`)。クリックで `#menu-panel` の `.open` クラスをトグル。
パネルは `position: absolute` で右上にフロート、`z-index: 20`。

外側クリックで自動的に閉じる(`document.addEventListener('click')` で判定)。

#### 4.6.2 設定項目: Preview chars(0–10)

スライダー(`<input type="range" min="0" max="10" value="4">`)で
ノードに表示するプロンプトの先頭文字数を変更する。

文字数を変えると以下が動的に変動する:
- `pillW = max(28, previewChars * 10.5 + 14)`
- `laneW = pillW + 24`
- SVG width も連動

0文字時はピル内テキストが空になり、ピル幅も最小(28px)。
10文字時はピル幅 119px、SVG 全幅は大きく広がる。

★ と ▼ の位置はピル中心から ±8px 固定(ピルが広がっても中央に集まる)。

### 4.7 状態管理(JS グローバル)

```js
const collapsed = new Set();    // 折りたたみ中のノード ID
let currentSelectedId = null;   // 詳細表示中のノード ID
let previewChars = 4;           // メニューで設定する文字数
let pillW, laneW;               // previewChars に応じて計算
let laneMap = new Map();        // 元 lane → 圧縮後 index
let currentSvgW = 0;            // 現在の SVG 幅
```

ピン留めとメモはノードオブジェクト自体に持つ(`n.pinned`, `n.memo`)。

### 4.8 描画フロー

```
ユーザー操作
  ↓
select() / deselect() / toggleCollapse() / charsSlider 変更 / pin toggle
  ↓
状態更新(collapsed Set, currentSelectedId, previewChars, n.pinned, ...)
  ↓
render()
  ├ recomputeLayout()  ← pillW/laneW/laneMap/SVG width 再計算
  ├ SVG 子要素全削除
  ├ レーン縦線描画(可視レーンのみ)
  ├ エッジ描画(両端の祖先が collapsed でないもの)
  ├ ノード描画(祖先が collapsed でないもの。自身 collapsed なら薄暗く)
  └ 折りたたみスタブ描画(collapsed 自身の下に短い点線)
```

---

## 5. コアコンセプトとの対応

`ideas/fork-graph.md` §0 で言語化されたコアコンセプトとの対応:

| コアコンセプト | プロトタイプでの実現 |
|--------------|-------------------|
| 会話の Fork を可視化 | レーン分けと曲線エッジによる git-graph 風表示 |
| ノード = プロンプト本文(の先頭数文字) | 4文字ピル(full では 0–10 で可変) |
| 見た目は git-graph 風 | 縦時間軸 + レーン + L字+曲線エッジ |
| 副次: ★ ピン留め | 右パネルのトグルバッジ |
| 副次: ✎ 主観メモ | データ上は保持、右パネルで表示(編集は未実装) |
| 副次: クリック → Claude Code 起動 | モック `alert()` |

未実装でコアに含まれるもの:
- **メモの編集**(右パネルから直接書き換え)— 本実装の最優先機能
- **実際の Claude Code セッションデータ読み込み** — ハードコードを置き換え

---

## 6. 既知の課題・本実装への引き継ぎ

### 6.1 描画ロジックの限界

- **同じ親から多数Forkが出るとき、エッジの水平移動部分が重なる**(`elbowY` が同じ値になる)。
  本実装では Fork ごとに `elbowY` を少しずらす必要。
- **エッジが他ノード/エッジを横切らない保証は手動レーン割当のみ**。
  原則A・B を実装したレイアウトアルゴリズムが必要(現状は手で配置)。

### 6.2 状態の永続化なし

- `n.pinned` の変更
- `collapsed` Set
- `previewChars` の設定値

これらはすべて JS メモリ上で、リロードで消える。本実装では VS Code の `globalState` または
`workspaceState` に保存する想定。

### 6.3 未実装の機能(本実装で検討すべきもの)

優先度順:
1. **メモ編集**(右パネル) — コアコンセプト直結
2. **★ピン付きだけ表示** フィルタ
3. **ホバーでプロンプト全文ツールチップ**
4. **検索ボックス**(プロンプト + メモ横断、ヒット以外を薄暗く)
5. **「いつ」の表示**(timestamp、相対時間)

### 6.4 実 Claude Code セッションデータとの対応

サンプルデータ(`sample-fork-graph.js`)の各フィールドと、
実 Claude Code セッションファイル(`~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`)
の対応:

| プロトタイプ | 実データの取得元 |
|-----------|----------------|
| `id` | レコードの `uuid`（ノード＝1メッセージ） |
| `parent` | `parentUuid`。user ノードだけの木にするなら「最も近い user 祖先」へ畳む |
| `lane` | アルゴリズムで自動計算(現状は手動割当) |
| `prompt` | `type: 'user'` レコードの `message.content` テキスト先頭 |
| `pinned` | 自前ストア(`globalState`/JSON)、`uuid` をキーに |
| `memo` | 自前ストア、同上 |

> 補足: ファイルは `<encoded-path>/` 直下に `<session-uuid>.jsonl` で置かれる（`sessions/` サブフォルダは無い）。
> パスのエンコードは「英数字以外を `-` に置換」。例: `c:\Users\natum\Desktop\claude-app\fork-graph`
> → `c--Users-natum-Desktop-claude-app-fork-graph`。

#### ★S0 調査結果（2026-06-05・実データ339ファイルを横断確認）— 確定

**結論: Fork 系譜は `.jsonl` 1ファイル内のメッセージ木として完全に復元できる。**

- **セッション内分岐**（`/rewind` `/branch`）が支配的。**1ファイル内で同じ `parentUuid` を持つ子が2つ以上**
  存在する箇所が分岐点。全339ファイル中 **48ファイル**に分岐点があった（このプロジェクトの
  `d8b477e8` は記録上12分岐点、user レベルに畳むと2分岐点）。
- **セッション間 Fork**（`--fork-session` で別ファイル）は**稀**（339ファイル中、外部 sessionId を
  含むファイルは1件のみ）。各ファイルは基本的に自分の `sessionId` だけを含み、ファイル間で `uuid` の
  共有も無い（＝相互に独立した木）。
- よって当初の懸念（「セッション間の親子を `isSidechain` 等で辿る必要があるか」）は**外れ**。
  `id=uuid` / `parent=parentUuid`（user 祖先へ畳む）/ `prompt=message.content` で**1ファイルから木が建つ**。
- 実装方針: **MVP1 は1セッション(.jsonl)を木として描く**。複数セッションを森として並べるのは後続。
  セッション間 Fork（稀）の対応は将来の拡張で十分。

### 6.5 ファイル形式は非公開API

Claude Code のセッションファイル形式は Anthropic 公式の安定APIではないため、
将来のバージョンで壊れる可能性がある。本実装ではバージョン互換性の考慮が必要。

---

## 7. 起動方法

### 7.1 prototype-minimal.html

外部依存ゼロ。以下のいずれかで開く:
- エクスプローラーでダブルクリック
- ブラウザのアドレスバーに `file:///c:/Users/natum/Desktop/claude-mem/ideas/prototype-minimal.html`

### 7.2 prototype-full.html

`sample-fork-graph.js` を `<script src>` で読み込むため、ブラウザの CORS 制限に注意。

**動作する開き方:**
- VS Code の Live Server 拡張で配信(推奨)
- ターミナルで `cd ideas && bunx serve` などで簡易HTTPサーバー起動
- Firefox の `file://`(緩い制限のため通る)

**動かない開き方:**
- Chrome/Edge の `file://` で直接ダブルクリック → CORS エラーで `SAMPLE_NODES` が undefined になる

### 7.3 環境前提

- 各種モダンブラウザ(SVG, CSS Grid, Fetch API 等)
- Node 24 系 / Bun 1.3+ がローカルにあると Live Server が立つ(必須ではない)

---

## 8. ファイル一覧

```
ideas/
├── PROTOTYPES.md            ← このドキュメント
├── fork-graph.md            ← コアコンセプトと発見プロセス
├── prototype-minimal.html   ← 最小プロトタイプ(独立)
├── prototype-full.html      ← 全機能プロトタイプ
└── sample-fork-graph.js     ← full のためのサンプルデータ
```
