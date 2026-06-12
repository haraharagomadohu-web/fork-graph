import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GraphNode,
  ProjectInfo,
  listProjects,
  loadForestForWorkspace,
  loadForestAnywhere,
  loadProjectAsForest,
  resolveProjectDir,
} from "./sessionLoader";

// MVP6+（2026-06-12 追加分）:
//  - 言語選択（英語デフォルト / 日本語 / 中国語 / 韓国語）… ☰メニュー、globalState に保存
//  - 日時検索（カレンダーで選んだ日のチャットを検索。テキスト検索と AND）… ヘッダー
//  - ソフトデリートの復元プレビュー … 復元リストから「別タブ」で該当の木だけを同 UI で表示。
//    対象の枝を可視化＋自動選択して「どこに接続されるか」を確認でき、復元前に
//    Open in Claude Code で中身も開ける。プレビューにはソフトデリート等の不要機能は出さない。
// UI 状態（選択・折りたたみ・ソフトデリート）は安定キー（node.key）で保持し、
// 自動リロード・フォルダ切替をまたいでも壊れない（MVP6 の方式を継続）。

const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
const CLAUDE_OPEN_COMMAND = "claude-vscode.editor.open";

const NOTES_STATE_KEY = "forkGraph.notes"; // MVP4: メモ・ピン
const SOFT_DELETED_STATE_KEY = "forkGraph.softDeleted"; // MVP6: ソフトデリート
const LANG_STATE_KEY = "forkGraph.lang"; // MVP6+: 表示言語（en/ja/zh/ko）
const OPEN_CLI_STATE_KEY = "forkGraph.openViaCli"; // Open を CLI 経路にするトグル（全ノード共通の好み）

interface NodeNote {
  memo: string;
  pinned: boolean;
  updatedAt: string;
}
type NotesMap = Record<string, NodeNote>;

interface SoftDeletedEntry {
  prompt: string;
  deletedAt: string;
}
type SoftDeletedMap = Record<string, SoftDeletedEntry>;

// Webview へ渡す（初期埋め込み／postMessage 共通の）ペイロード。
interface Payload {
  nodes: GraphNode[];
  projectDir?: string;
  projectLabel: string;
  sessionCount: number;
  noteCode?: "fallback" | "empty"; // 文言は Webview 側で言語に応じて表示
  projects: { dir: string; label: string; mtime: number }[];
  softDeleted: { key: string; prompt: string; deletedAt: string }[];
  hiddenSessions: string[];
  lang: string; // en / ja / zh / ko
  preview?: { focusKey: string }; // 復元プレビューモード（この枝を可視化して自動選択）
  // 表示中フォルダが「VS Code ワークスペースに対応するフォルダ」と異なるか。
  // true のとき公式 editor.open は黙って新規チャットにすり替わる（resume はワークスペースの
  // プロジェクト内しか探さない）ため、Open は CLI 経路（そのフォルダの実 cwd でターミナル起動）にする。
  foreign: boolean;
  projectCwd?: string; // 表示中プロジェクトの実パス（CLI 起動時の cwd に使う）
  openViaCli: boolean; // Open ボタンを CLI 経路にするトグルの保存値
}

let panel: vscode.WebviewPanel | undefined; // メイン
const previewPanels = new Map<string, vscode.WebviewPanel>(); // focusKey → プレビュー
let currentProjectDir: string | undefined;
let watcher: fs.FSWatcher | undefined;
let watchTimer: ReturnType<typeof setTimeout> | undefined;

// Webview が vscode.setState() で保存する状態（Reload Window 後の復元に使う）。
interface WebviewState {
  projectDir?: string | null;
  focusKey?: string | null; // プレビューのみ
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("fork-graph.open", () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const p = vscode.window.createWebviewPanel(
      "forkGraphPanel",
      "Fork Graph",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true }
    );
    initMainPanel(context, p, undefined);
  });

  context.subscriptions.push(disposable);

  // Developer: Reload Window（や VS Code 再起動）後にタブを消さないためのシリアライザ。
  // VS Code はタブの「枠」を復元してこのコールバックを呼ぶので、Webview の setState に
  // 保存しておいたプロジェクト／focusKey から中身を建て直す。
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("forkGraphPanel", {
      async deserializeWebviewPanel(p, state: WebviewState | undefined) {
        if (panel) {
          p.dispose(); // 二重復元の保険（通常は起きない）
          return;
        }
        initMainPanel(context, p, state?.projectDir ?? undefined);
      },
    }),
    vscode.window.registerWebviewPanelSerializer("forkGraphPreview", {
      async deserializeWebviewPanel(p, state: WebviewState | undefined) {
        if (state?.focusKey) {
          initPreviewPanel(context, p, state.focusKey, state.projectDir ?? undefined);
        } else {
          p.dispose(); // 復元情報が無ければ建て直せない
        }
      },
    })
  );
}

// メインパネルの中身を組み立てる（新規作成・Reload 復元の共通経路）。
function initMainPanel(
  context: vscode.ExtensionContext,
  p: vscode.WebviewPanel,
  projectDir: string | undefined
): void {
  panel = p;
  p.webview.options = { enableScripts: true };

  const initial = buildPayload(
    context,
    projectDir && fs.existsSync(projectDir) ? projectDir : undefined
  );
  currentProjectDir = initial.projectDir;
  p.webview.html = getWebviewHtml(initial);
  setupWatcher(context);

  p.webview.onDidReceiveMessage(
    (msg: Msg) => handleMessage(context, msg),
    null,
    context.subscriptions
  );

  p.onDidDispose(
    () => {
      if (panel === p) {
        disposeWatcher();
        panel = undefined;
      }
    },
    null,
    context.subscriptions
  );
}

interface Msg {
  type?: string;
  sessionId?: string;
  key?: string;
  memo?: string;
  pinned?: boolean;
  prompt?: string;
  dir?: string;
  lang?: string;
  cwd?: string; // openSessionCli: ターミナルの作業ディレクトリ（別フォルダのチャットを開くため）
  value?: boolean; // setOpenViaCli: トグル値
}

// メイン／プレビュー共通のメッセージハンドラ。
function handleMessage(context: vscode.ExtensionContext, msg: Msg): void {
  if (msg.type === "openSession" && msg.sessionId) {
    openSession(msg.sessionId);
  } else if (msg.type === "openSessionCli" && msg.sessionId) {
    // 削除済み（非表示）セッション・別フォルダのセッションは公式 editor.open だと
    // 黙って新規チャットにすり替わるため（resume はワークスペースのプロジェクト内しか
    // 探さない）、CLI 経由でのみ開く。別フォルダの場合は cwd をそのフォルダに合わせる
    // （cwd が違うと CLI も別プロジェクト扱いで見つけられない）。
    openSessionInTerminal(msg.sessionId, msg.cwd);
  } else if (msg.type === "saveNote" && msg.key) {
    saveNote(context, msg.key, msg.memo ?? "", msg.pinned ?? false);
  } else if (msg.type === "softDelete" && msg.key) {
    updateSoftDeleted(context, msg.key, msg.prompt ?? "").then(() => postData(context));
  } else if (msg.type === "restoreNode" && msg.key) {
    // プレビューからの復元でもメイン側の表示・復元リストを更新する
    updateSoftDeleted(context, msg.key, undefined).then(() => postData(context));
  } else if (msg.type === "switchProject" && msg.dir) {
    currentProjectDir = msg.dir;
    postData(context);
    setupWatcher(context);
  } else if (msg.type === "requestReload") {
    postData(context);
  } else if (msg.type === "setLang" && msg.lang) {
    context.globalState.update(LANG_STATE_KEY, msg.lang);
  } else if (msg.type === "setOpenViaCli") {
    context.globalState.update(OPEN_CLI_STATE_KEY, !!msg.value);
  } else if (msg.type === "openPreview" && msg.key) {
    openPreview(context, msg.key);
  }
}

// ---- 復元プレビュー（別タブ）---------------------------------------------
// ソフトデリートされた key を含む「木 1 本」だけを、同じ UI（不要機能は非表示）で表示する。
// 対象の枝は可視化＋自動選択され、どこに接続されるか・中身（Open in Claude Code）を
// 復元前に確認できる。
function openPreview(context: vscode.ExtensionContext, focusKey: string): void {
  const existing = previewPanels.get(focusKey);
  if (existing) {
    existing.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const pv = vscode.window.createWebviewPanel(
    "forkGraphPreview",
    "Fork Graph Preview",
    vscode.ViewColumn.Beside, // メインの隣の別タブで開く
    { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true }
  );
  initPreviewPanel(context, pv, focusKey, currentProjectDir);
}

// プレビューパネルの中身を組み立てる（新規作成・Reload 復元の共通経路）。
function initPreviewPanel(
  context: vscode.ExtensionContext,
  pv: vscode.WebviewPanel,
  focusKey: string,
  projectDir: string | undefined
): void {
  pv.webview.options = { enableScripts: true };
  const dir = projectDir && fs.existsSync(projectDir) ? projectDir : currentProjectDir;
  pv.webview.html = getWebviewHtml(buildPayload(context, dir, focusKey));
  pv.webview.onDidReceiveMessage(
    (msg: Msg) => handleMessage(context, msg),
    null,
    context.subscriptions
  );
  previewPanels.set(focusKey, pv);
  pv.onDidDispose(() => previewPanels.delete(focusKey), null, context.subscriptions);
}

// ---- 自動リロード（MVP6）-------------------------------------------------
// 表示中プロジェクトの .jsonl の追記を debounce してメインパネルへ最新データを送る。
function setupWatcher(context: vscode.ExtensionContext): void {
  disposeWatcher();
  if (!currentProjectDir || !fs.existsSync(currentProjectDir)) {
    return;
  }
  try {
    watcher = fs.watch(currentProjectDir, { persistent: false }, (_ev, file) => {
      if (file && !String(file).endsWith(".jsonl")) {
        return;
      }
      if (watchTimer) {
        clearTimeout(watchTimer);
      }
      watchTimer = setTimeout(() => postData(context), 600);
    });
  } catch {
    // 監視に失敗してもグラフ表示自体は成立する
  }
}

function disposeWatcher(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = undefined;
  }
  watcher?.close();
  watcher = undefined;
}

function postData(context: vscode.ExtensionContext): void {
  if (!panel) {
    return;
  }
  panel.webview.postMessage({
    type: "data",
    payload: buildPayload(context, currentProjectDir),
  });
}

// ---- セッションを開く（MVP3/MVP5）---------------------------------------
async function openSession(sessionId: string): Promise<void> {
  const claude = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (claude) {
    try {
      await claude.activate();
      await vscode.commands.executeCommand(
        CLAUDE_OPEN_COMMAND,
        sessionId,
        undefined,
        vscode.ViewColumn.Active
      );
      return;
    } catch (err) {
      vscode.window.showErrorMessage(
        `Fork Graph: セッションを開けませんでした（公式コマンド失敗）: ${String(err)}`
      );
      return;
    }
  }
  const pick = await vscode.window.showWarningMessage(
    "Fork Graph: Claude Code 拡張が見つかりません。ターミナルで再開しますか？",
    "ターミナルで開く"
  );
  if (pick === "ターミナルで開く") {
    openSessionInTerminal(sessionId);
  }
}

function openSessionInTerminal(sessionId: string, cwd?: string): void {
  // cwd 指定（別フォルダのチャット）はそのフォルダで起動する。
  // CLI の --resume は「現在の cwd に対応するプロジェクト」からセッションを探すため、
  // cwd を合わせないと見つからない。フォルダが消えている場合は通常起動にフォールバック。
  const useCwd = cwd && fs.existsSync(cwd) ? cwd : undefined;
  // 下部パネルではなくエディタ領域の新しいタブとしてターミナルを開く（要望 2026-06-12）
  const term = vscode.window.createTerminal({
    name: "Fork Graph",
    cwd: useCwd,
    location: vscode.TerminalLocation.Editor,
  });
  term.show();
  term.sendText(`claude --resume ${sessionId}`);
}

// 公式 UI で「削除」されたセッション ID 一覧（MVP5。詳細は実装ドキュメント参照）。
function readHiddenSessionIds(): string[] {
  try {
    const dbPath = path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "Code",
      "User",
      "globalStorage",
      "state.vscdb"
    );
    const buf = fs.readFileSync(dbPath);
    const marker = Buffer.from('"hiddenSessionIds":');
    const at = buf.indexOf(marker);
    if (at < 0) {
      return [];
    }
    const windowText = buf
      .subarray(at, Math.min(buf.length, at + 8192))
      .toString("utf-8");
    const arrEnd = windowText.indexOf("]");
    const segment = arrEnd > 0 ? windowText.slice(0, arrEnd) : windowText;
    return (
      segment.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
      ) ?? []
    );
  } catch {
    return [];
  }
}

// ---- 永続化（MVP4 メモ／MVP6 ソフトデリート）-----------------------------
async function saveNote(
  context: vscode.ExtensionContext,
  key: string,
  memo: string,
  pinned: boolean
): Promise<void> {
  const notes = { ...(context.globalState.get<NotesMap>(NOTES_STATE_KEY) ?? {}) };
  if (memo.trim() === "" && !pinned) {
    delete notes[key];
  } else {
    notes[key] = { memo, pinned, updatedAt: new Date().toISOString() };
  }
  await context.globalState.update(NOTES_STATE_KEY, notes);
}

async function updateSoftDeleted(
  context: vscode.ExtensionContext,
  key: string,
  prompt: string | undefined
): Promise<void> {
  const map = {
    ...(context.globalState.get<SoftDeletedMap>(SOFT_DELETED_STATE_KEY) ?? {}),
  };
  if (prompt === undefined) {
    delete map[key];
  } else {
    map[key] = { prompt, deletedAt: new Date().toISOString() };
  }
  await context.globalState.update(SOFT_DELETED_STATE_KEY, map);
}

export function deactivate() {
  disposeWatcher();
  for (const pv of previewPanels.values()) {
    pv.dispose();
  }
  previewPanels.clear();
  panel?.dispose();
  panel = undefined;
}

// ---- データ組み立て -------------------------------------------------------
// previewFocusKey 指定時は「その key を含む木 1 本」にノードを絞り、preview モードにする。
function buildPayload(
  context: vscode.ExtensionContext,
  projectDir: string | undefined,
  previewFocusKey?: string
): Payload {
  let nodes: GraphNode[] = [];
  let dir: string | undefined;
  let sessionCount = 0;
  let noteCode: Payload["noteCode"];

  if (projectDir && fs.existsSync(projectDir)) {
    const r = loadProjectAsForest(projectDir);
    nodes = r.nodes;
    dir = projectDir;
    sessionCount = r.sessionFiles.length;
  } else {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsResult = ws ? loadForestForWorkspace(ws) : undefined;
    const r = wsResult ?? loadForestAnywhere();
    if (r) {
      nodes = r.nodes;
      dir = r.projectDir;
      sessionCount = r.sessionFiles.length;
      if (!wsResult) {
        noteCode = "fallback";
      }
    } else {
      noteCode = "empty";
    }
  }

  // 保存済みメモ・ピンを付与（MVP4）
  const notes = context.globalState.get<NotesMap>(NOTES_STATE_KEY) ?? {};
  for (const n of nodes) {
    const nt = notes[n.key];
    if (nt) {
      n.memo = nt.memo;
      n.pinned = nt.pinned;
    }
  }

  // プレビュー: focusKey を含む木 1 本に絞る
  if (previewFocusKey) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const focus = nodes.find((n) => n.key === previewFocusKey);
    if (focus) {
      let root = focus;
      while (root.parent && byId.get(root.parent)) {
        root = byId.get(root.parent)!;
      }
      const rootOf = (n: GraphNode): GraphNode => {
        let cur = n;
        while (cur.parent && byId.get(cur.parent)) {
          cur = byId.get(cur.parent)!;
        }
        return cur;
      };
      nodes = nodes.filter((n) => rootOf(n).id === root.id);
    }
  }

  const softMap =
    context.globalState.get<SoftDeletedMap>(SOFT_DELETED_STATE_KEY) ?? {};

  const projects = listProjects().map((p: ProjectInfo) => ({
    dir: p.dir,
    label: p.label,
    mtime: p.mtime,
  }));

  // 表示中フォルダがワークスペース対応フォルダと違う場合、公式 resume では開けない（→ CLI 経路）。
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const wsProjectDir = ws ? resolveProjectDir(ws) : undefined;
  const foreign = !!(dir && wsProjectDir && dir !== wsProjectDir);
  const projectCwd = dir
    ? projects.find((p) => p.dir === dir)?.label
    : undefined;

  return {
    nodes,
    projectDir: dir,
    projectLabel: dir ? path.basename(dir) : "(no project)",
    sessionCount,
    noteCode,
    projects,
    softDeleted: Object.entries(softMap).map(([key, e]) => ({
      key,
      prompt: e.prompt,
      deletedAt: e.deletedAt,
    })),
    hiddenSessions: readHiddenSessionIds(),
    lang: context.globalState.get<string>(LANG_STATE_KEY) ?? "en", // デフォルトは英語
    preview: previewFocusKey ? { focusKey: previewFocusKey } : undefined,
    foreign,
    projectCwd,
    // デフォルト ON: CLI で Claude Code を使う人が多いため、未設定なら CLI 経路で開く（要望 2026-06-12）
    openViaCli: context.globalState.get<boolean>(OPEN_CLI_STATE_KEY) ?? true,
  };
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// </script> 注入や HTML 破壊を防ぐため "<" をエスケープしてから埋め込む。
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// prototype-full.html 準拠の Webview（MVP5）＋ MVP6/MVP6+ の仕上げ機能。
function getWebviewHtml(initial: Payload): string {
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fork Graph</title>
<style>
  :root {
    --bg: #1e1e1e;
    --bg-panel: #252526;
    --fg: #d4d4d4;
    --fg-dim: #858585;
    --border: #3c3c3c;
    --accent: #d97757;
    --lane-0: #4ec9b0;
    --lane-1: #c586c0;
    --lane-2: #ce9178;
    --lane-3: #569cd6;
    --lane-4: #dcdcaa;
    --lane-5: #4fc1ff;
    --lane-6: #f48771;
    --lane-7: #b5cea8;
    --lane-8: #d7ba7d;
    --lane-9: #6796e6;
    --lane-10: #b267e6;
    --lane-11: #e672a6;
    --lane-12: #ff8c00;
    --lane-13: #00ced1;
    --lane-14: #a8c5e0;
    --lane-15: #c9b8a0;
    --lane-16: #9fb89e;
    --lane-17: #d4a4ce;
    --pin: #ffd700;
    --memo: #4ec9b0;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Yu Gothic UI", sans-serif; font-size: 13px; }
  body { display: flex; flex-direction: column; }

  /* Header */
  header { padding: 12px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; position: relative; flex: none; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; white-space: nowrap; }
  header .preview-tag { color: var(--accent); font-size: 11px; border: 1px solid var(--accent); border-radius: 10px; padding: 2px 8px; white-space: nowrap; }
  header .meta { color: var(--fg-dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .spacer { flex: 1; }
  #search-box { background: var(--bg-panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 5px 10px; font-size: 12px; width: 190px; }
  #search-box:focus { outline: none; border-color: var(--accent); }
  /* MVP6+: カレンダー（日付＋時刻検索）。内蔵 date input はロケールが切替できないため自前実装 */
  #date-btn { background: var(--bg-panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  #date-btn:hover { border-color: var(--accent); }
  #date-btn.active { border-color: var(--accent); color: var(--accent); }
  #date-clear { background: transparent; color: var(--fg-dim); border: none; cursor: pointer; font-size: 13px; padding: 2px; }
  #date-clear:hover { color: var(--fg); }
  #cal-panel { position: absolute; top: 49px; right: 20px; background: var(--bg-panel); border: 1px solid var(--border);
    border-radius: 6px; padding: 12px 14px; display: none; z-index: 21; box-shadow: 0 4px 12px rgba(0,0,0,0.4); width: 252px; }
  #cal-panel.open { display: block; }
  .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .cal-head button { background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 4px;
    width: 24px; height: 24px; cursor: pointer; font-size: 13px; line-height: 1; }
  .cal-head button:hover { border-color: var(--accent); }
  .cal-head .cal-title { font-size: 12px; font-weight: 600; }
  #cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  #cal-grid .dow { text-align: center; font-size: 10px; color: var(--fg-dim); padding: 2px 0; user-select: none; }
  #cal-grid .day { text-align: center; font-size: 11px; padding: 4px 0 6px; border-radius: 4px; cursor: pointer;
    position: relative; color: var(--fg); user-select: none; }
  #cal-grid .day:hover { background: var(--bg); }
  #cal-grid .day.out { color: var(--fg-dim); opacity: 0.4; }
  #cal-grid .day.selected { background: var(--accent); color: #fff; }
  #cal-grid .day.has-chat::after { content: ''; position: absolute; left: 50%; bottom: 1px; transform: translateX(-50%);
    width: 4px; height: 4px; border-radius: 2px; background: var(--memo); }
  #cal-grid .day.selected.has-chat::after { background: #fff; }
  .cal-time-row { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: var(--fg-dim); }
  .cal-time-row input[type=time] { flex: 1; background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 3px 6px; font-size: 12px; color-scheme: dark; }
  .cal-time-row input[type=time]:focus { outline: none; border-color: var(--accent); }
  .cal-actions { margin-top: 10px; text-align: right; }
  .cal-actions button { background: var(--bg); color: var(--fg-dim); border: 1px solid var(--border); border-radius: 4px;
    padding: 3px 10px; cursor: pointer; font-size: 11px; }
  .cal-actions button:hover { color: var(--fg); border-color: var(--accent); }
  #search-count { color: var(--fg-dim); font-size: 11px; white-space: nowrap; }
  #menu-btn { background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 14px; }
  #menu-btn:hover { background: var(--bg-panel); }
  #menu-btn.active { background: var(--bg-panel); border-color: var(--accent); }
  /* MVP6+: プレビューの復元ボタン */
  #preview-restore-btn { background: var(--accent); color: #fff; border: none; border-radius: 4px;
    padding: 5px 14px; cursor: pointer; font-size: 12px; font-weight: 500; white-space: nowrap; }
  #preview-restore-btn:hover { filter: brightness(1.1); }
  #preview-restore-btn:disabled { opacity: 0.5; cursor: default; }

  .note { padding: 8px 20px; color: var(--fg-dim); border-bottom: 1px solid var(--border);
    background: #2a2a2a; font-size: 12px; flex: none; }

  /* Menu panel */
  #menu-panel { position: absolute; top: 49px; right: 20px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; display: none; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.4); min-width: 300px; max-width: 420px; max-height: 70vh; overflow-y: auto; }
  #menu-panel.open { display: block; }
  #menu-panel h3 { margin: 14px 0 8px; font-size: 11px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  #menu-panel h3:first-child { margin-top: 0; }
  #menu-panel label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--fg); }
  #menu-panel .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  #menu-panel .value { color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
  #menu-panel input[type=range] { width: 100%; accent-color: var(--accent); }
  #menu-panel .check-row { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; flex-direction: row; }
  #menu-panel input[type=checkbox] { accent-color: var(--pin); }
  #project-select, #lang-select { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 5px 8px; font-size: 12px; }
  .restore-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px dotted var(--border); }
  .restore-item .snippet { flex: 1; color: var(--fg-dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .restore-item button { background: var(--bg); border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; white-space: nowrap; }
  .restore-item button.restore { color: var(--memo); border: 1px solid var(--memo); }
  .restore-item button.preview { color: var(--accent); border: 1px solid var(--accent); }
  .restore-item button:hover { filter: brightness(1.2); }
  .restore-empty { color: var(--fg-dim); font-size: 11px; font-style: italic; }

  main { display: grid; grid-template-columns: 1fr 360px; flex: 1; min-height: 0; transition: grid-template-columns 0.2s; }
  main.no-detail { grid-template-columns: 1fr 0; }
  main.no-detail aside { display: none; }
  #graph { overflow: auto; padding: 16px 0; }
  #graph svg { display: block; transition: width 0.2s; }
  .empty { padding: 40px 20px; color: var(--fg-dim); }

  /* Aside (detail panel) */
  aside { background: var(--bg-panel); border-left: 1px solid var(--border); padding: 16px 18px; overflow-y: auto; position: relative; }
  aside h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; padding-right: 28px; }
  aside h3 { margin: 18px 0 6px; font-size: 12px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  aside .prompt-full { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; line-height: 1.6; white-space: pre-wrap; }
  aside .when { color: var(--fg); font-size: 12px; }
  aside .when .rel { color: var(--fg-dim); margin-left: 6px; }
  aside .memo-edit { width: 100%; min-height: 72px; resize: vertical; background: var(--bg); border: 1px solid var(--border);
    border-left: 3px solid var(--memo); border-radius: 4px; padding: 10px 12px; line-height: 1.5; color: var(--fg);
    font-family: inherit; font-size: 13px; }
  aside .memo-edit::placeholder { color: var(--fg-dim); font-style: italic; }
  aside .memo-save { margin-top: 6px; padding: 6px 14px; background: var(--bg); color: var(--memo);
    border: 1px solid var(--memo); border-radius: 4px; cursor: pointer; font-size: 12px; }
  aside .memo-save:hover { filter: brightness(1.2); }
  aside .save-state { color: #6a9955; font-size: 11px; margin-left: 8px; }
  aside .badges { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  aside .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); color: var(--fg-dim); }
  aside .badge.pin-toggle { cursor: pointer; user-select: none; transition: opacity 0.15s, color 0.15s, border-color 0.15s; }
  aside .badge.pin-toggle.on { color: var(--pin); border-color: var(--pin); opacity: 1; }
  aside .badge.pin-toggle.off { color: var(--fg-dim); border-color: var(--border); opacity: 0.5; }
  aside .badge.pin-toggle:hover { filter: brightness(1.2); opacity: 1; }
  aside .open-btn { margin-top: 16px; width: 100%; padding: 10px; background: var(--accent); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; }
  aside .open-btn:hover { filter: brightness(1.1); }
  aside .open-btn:disabled { opacity: 0.4; cursor: default; }
  /* Open の経路トグル（公式拡張 / CLI）。削除済み・別フォルダは CLI 固定 */
  aside .open-cli-row { display: flex; align-items: center; gap: 6px; margin-top: 6px;
    font-size: 12px; color: var(--fg-dim); cursor: pointer; user-select: none; }
  aside .open-cli-row input[type=checkbox] { accent-color: var(--accent); }
  aside .open-cli-row.forced { opacity: 0.6; cursor: default; }
  aside .soft-delete-btn { margin-top: 8px; width: 100%; padding: 7px; background: var(--bg); color: #f48771;
    border: 1px solid #f48771; border-radius: 4px; cursor: pointer; font-size: 12px; }
  aside .soft-delete-btn:hover { filter: brightness(1.2); }
  aside .empty-state { color: var(--fg-dim); font-style: italic; padding: 40px 0; text-align: center; }
  aside .close-btn {
    position: absolute; top: 12px; right: 12px;
    width: 24px; height: 24px;
    background: transparent; border: none;
    color: var(--fg-dim); cursor: pointer;
    font-size: 18px; line-height: 1; padding: 0; margin: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 4px;
  }
  aside .close-btn:hover { color: var(--fg); background: var(--bg); }

  /* SVG */
  .edge { fill: none; stroke-width: 2; opacity: 0.7; }
  .edge.dim { opacity: 0.12; }
  /* /compact の実行位置（エッジを 2 重波線で交差させる。チャートの軸省略記号 ≈ と同じ読み方） */
  .compact-mark path { fill: none; stroke-width: 1.6; opacity: 0.95; }
  .compact-mark.dim { opacity: 0.12; }
  .edge-stub { fill: none; stroke-width: 2; opacity: 0.5; stroke-dasharray: 3 3; }
  .node { cursor: pointer; }
  .node-pill { transition: stroke-width 0.15s; }
  .node-label { font-size: 13px; font-family: ui-monospace, "SF Mono", "Yu Gothic UI", monospace;
    pointer-events: none; user-select: none; }
  .node:hover .node-pill { stroke-width: 2.5; filter: brightness(1.3); }
  .node.selected .node-pill { stroke: #fff; stroke-width: 2.5; }
  .node.selected .node-label { fill: #fff; }
  .node.collapsed-self { opacity: 0.35; }
  .node.dim { opacity: 0.18; }
  /* MVP6+: 復元プレビューの対象枝を強調 */
  .node.focus-branch .node-pill { stroke-width: 2.5; filter: drop-shadow(0 0 4px var(--accent)); }
  .badge-icon { font-size: 11px; user-select: none; pointer-events: none; }
  .toggle-icon { font-size: 11px; user-select: none; pointer-events: all; cursor: pointer; opacity: 0.85; }
  .toggle-icon:hover { opacity: 1; font-weight: bold; }
</style>
</head>
<body>

<header>
  <h1>Fork Graph</h1>
  <span id="preview-tag" class="preview-tag" style="display:none"></span>
  <span id="meta" class="meta"></span>
  <div class="spacer"></div>
  <button id="preview-restore-btn" style="display:none"></button>
  <input id="search-box" type="search">
  <button id="date-btn">&#128197;</button>
  <button id="date-clear" title="" style="display:none">×</button>
  <span id="search-count"></span>
  <button id="menu-btn" title="Settings">☰</button>
</header>

<!-- MVP6+: 自前カレンダー（Intl でロケール追従。チャットのある日は ● マーカー） -->
<div id="cal-panel">
  <div class="cal-head">
    <button id="cal-prev">&#8249;</button>
    <span class="cal-title" id="cal-title"></span>
    <button id="cal-next">&#8250;</button>
  </div>
  <div id="cal-grid"></div>
  <div class="cal-time-row">
    <input type="time" id="time-from"><span>–</span><input type="time" id="time-to">
  </div>
  <div class="cal-actions"><button id="cal-clear"></button></div>
</div>

<div id="menu-panel">
  <div id="menu-main-only">
    <h3 id="h-project"></h3>
    <select id="project-select"></select>
  </div>
  <h3 id="h-display"></h3>
  <label>
    <div class="row">
      <span id="l-chars"></span>
      <span class="value"><span id="chars-display">4</span> / 10</span>
    </div>
    <input type="range" id="chars-slider" min="0" max="10" step="1" value="4">
  </label>
  <h3 id="h-language"></h3>
  <select id="lang-select">
    <option value="en">English</option>
    <option value="ja">日本語</option>
    <option value="zh">中文</option>
    <option value="ko">한국어</option>
  </select>
  <h3 id="h-filter"></h3>
  <label class="check-row"><input type="checkbox" id="pin-only"> <span id="l-pinonly"></span></label>
  <div id="menu-restore-block">
    <h3 id="h-restore"></h3>
    <div id="restore-list"></div>
  </div>
</div>

<div id="note-banner" class="note" style="display:none"></div>
<main class="no-detail">
  <section id="graph"></section>
  <aside id="detail"></aside>
</main>

<script nonce="${nonce}">
const SVGNS = 'http://www.w3.org/2000/svg';
const vscode = acquireVsCodeApi();

/* ============================================================
   i18n（MVP6+）— デフォルト英語。ja/zh/ko を同梱
   ============================================================ */
const I18N = {
  en: {
    searchPh: 'Search (prompt + memo)', hits: ' hits', dateTitle: 'Filter by date', clearDate: 'Clear date filter',
    hProject: 'Project', hDisplay: 'Display Settings', lChars: 'Preview chars', hLanguage: 'Language', hFilter: 'Filter',
    lPinOnly: '★ Pinned only (+ ancestor path)', hRestore: 'Restore soft-deleted',
    restoreEmpty: '(no soft-deleted nodes)', restore: 'Restore', previewBtn: 'Preview',
    selected: 'Selected Session', prompt: 'Prompt', when: 'When', memo: 'Memo',
    memoPh: '(no memo yet) — e.g. "this was the good state"', saveMemo: 'Save memo', saved: 'Saved',
    openBtn: '\\u25B6 Open in Claude Code', openCli: '\\u25B6 Deleted \\u2014 open via CLI', openCliForeign: '\\u25B6 Open via CLI (other folder)', openBtnCli: '\\u25B6 Open in Claude Code (CLI)', cliToggle: 'Open via CLI (terminal tab)', cliForced: '(CLI only for this node)',
    compactTitle: 'Context compacted here (/compact)',
    softDelete: '\\u{1F5D1} Soft delete (hide this node and descendants)',
    softDeleteTitle: 'Hides this node and its descendants from Fork Graph only. No data is deleted. Restore from the \\u2630 menu.',
    deletedBadge: 'deleted', deletedTitle: 'Deleted (hidden) in the official UI. Data is intact and can be opened via CLI.',
    pinned: 'pinned', notPinned: 'not pinned', pinTitle: 'Click to toggle pin', collapsedBadge: '\\u25B6 collapsed',
    noSession: 'This node has no session info', noNodes: 'No nodes to display.', noTime: '(no timestamp)',
    previewTag: 'Restore preview', restoreHere: '\\u2934 Restore this branch', restored: 'Restored',
    sessions: ' sessions', nodes: ' nodes', forks: ' forks',
    noteFallback: 'No project matches the current workspace; showing the most recently active project.',
    noteEmpty: 'No sessions (.jsonl) found under ~/.claude/projects.',
    justNow: 'just now', minAgo: 'm ago', hourAgo: 'h ago', dayAgo: 'd ago', moAgo: 'mo ago', yrAgo: 'y ago'
  },
  ja: {
    searchPh: '検索（プロンプト＋メモ）', hits: ' 件', dateTitle: '日付で検索', clearDate: '日付フィルタを解除',
    hProject: 'プロジェクト', hDisplay: '表示設定', lChars: 'プレビュー文字数', hLanguage: '言語', hFilter: 'フィルタ',
    lPinOnly: '★ ピン付きだけ表示（＋祖先パス）', hRestore: '非表示済みチャットから復元',
    restoreEmpty: '（ソフトデリートしたノードはありません）', restore: '復元', previewBtn: 'プレビュー',
    selected: '選択中のセッション', prompt: 'プロンプト', when: 'いつ', memo: 'メモ',
    memoPh: '(まだメモなし) — あの良い状態だった、等', saveMemo: 'メモを保存', saved: '保存しました',
    openBtn: '\\u25B6 Open in Claude Code', openCli: '\\u25B6 削除済み — CLI で開く', openCliForeign: '\\u25B6 別フォルダ — CLI で開く', openBtnCli: '\\u25B6 Open in Claude Code（CLI）', cliToggle: 'CLI で開く（ターミナルタブ）', cliForced: '（このノードは CLI のみ）',
    compactTitle: 'ここで /compact を実行（コンテキスト圧縮）',
    softDelete: '\\u{1F5D1} ソフトデリート（このノード以降を非表示）',
    softDeleteTitle: 'このノードと以降（子孫）を Fork Graph の表示から隠します。データは消えません。☰メニューから復元できます。',
    deletedBadge: '削除済み', deletedTitle: '公式 UI で削除（非表示化）されたセッション。データは残っており CLI で開けます。',
    pinned: 'pinned', notPinned: 'not pinned', pinTitle: 'クリックでピン留めを切り替え', collapsedBadge: '\\u25B6 折りたたみ中',
    noSession: 'このノードにはセッション情報がありません', noNodes: '表示できるノードがありません。', noTime: '（時刻情報なし）',
    previewTag: '復元プレビュー', restoreHere: '\\u2934 この枝を復元する', restored: '復元しました',
    sessions: ' sessions', nodes: ' nodes', forks: ' forks',
    noteFallback: '現在のワークスペースに対応するプロジェクトが見つからないため、直近に活動したプロジェクトの森を表示しています。',
    noteEmpty: '~/.claude/projects 内にセッション (.jsonl) が見つかりませんでした。',
    justNow: 'たった今', minAgo: '分前', hourAgo: '時間前', dayAgo: '日前', moAgo: 'ヶ月前', yrAgo: '年前'
  },
  zh: {
    searchPh: '搜索（提示词＋备注）', hits: ' 条', dateTitle: '按日期搜索', clearDate: '清除日期筛选',
    hProject: '项目', hDisplay: '显示设置', lChars: '预览字数', hLanguage: '语言', hFilter: '筛选',
    lPinOnly: '★ 仅显示已固定（＋祖先路径）', hRestore: '从已隐藏的会话恢复',
    restoreEmpty: '（没有软删除的节点）', restore: '恢复', previewBtn: '预览',
    selected: '选中的会话', prompt: '提示词', when: '时间', memo: '备注',
    memoPh: '（暂无备注）— 例如「这是状态很好的节点」', saveMemo: '保存备注', saved: '已保存',
    openBtn: '\\u25B6 Open in Claude Code', openCli: '\\u25B6 已删除 — 通过 CLI 打开', openCliForeign: '\\u25B6 其他文件夹 — 通过 CLI 打开', openBtnCli: '\\u25B6 Open in Claude Code（CLI）', cliToggle: '通过 CLI 打开（终端标签页）', cliForced: '（此节点仅限 CLI）',
    compactTitle: '在此执行了 /compact（上下文压缩）',
    softDelete: '\\u{1F5D1} 软删除（隐藏此节点及其后代）',
    softDeleteTitle: '仅在 Fork Graph 中隐藏此节点及其后代。不会删除数据。可从 ☰ 菜单恢复。',
    deletedBadge: '已删除', deletedTitle: '在官方 UI 中已删除（隐藏）的会话。数据完好，可通过 CLI 打开。',
    pinned: 'pinned', notPinned: 'not pinned', pinTitle: '点击切换固定', collapsedBadge: '\\u25B6 已折叠',
    noSession: '此节点没有会话信息', noNodes: '没有可显示的节点。', noTime: '（无时间信息）',
    previewTag: '恢复预览', restoreHere: '\\u2934 恢复此分支', restored: '已恢复',
    sessions: ' sessions', nodes: ' nodes', forks: ' forks',
    noteFallback: '未找到与当前工作区对应的项目，正在显示最近活动的项目。',
    noteEmpty: '在 ~/.claude/projects 中未找到会话 (.jsonl)。',
    justNow: '刚刚', minAgo: '分钟前', hourAgo: '小时前', dayAgo: '天前', moAgo: '个月前', yrAgo: '年前'
  },
  ko: {
    searchPh: '검색（프롬프트＋메모）', hits: '건', dateTitle: '날짜로 검색', clearDate: '날짜 필터 해제',
    hProject: '프로젝트', hDisplay: '표시 설정', lChars: '미리보기 글자 수', hLanguage: '언어', hFilter: '필터',
    lPinOnly: '★ 핀 고정만 표시（＋조상 경로）', hRestore: '숨긴 채팅 복원',
    restoreEmpty: '（소프트 삭제한 노드가 없습니다）', restore: '복원', previewBtn: '미리보기',
    selected: '선택된 세션', prompt: '프롬프트', when: '시기', memo: '메모',
    memoPh: '(메모 없음) — 예: "이때 상태가 좋았다"', saveMemo: '메모 저장', saved: '저장했습니다',
    openBtn: '\\u25B6 Open in Claude Code', openCli: '\\u25B6 삭제됨 — CLI로 열기', openCliForeign: '\\u25B6 다른 폴더 — CLI로 열기', openBtnCli: '\\u25B6 Open in Claude Code（CLI）', cliToggle: 'CLI로 열기（터미널 탭）', cliForced: '（이 노드는 CLI 전용）',
    compactTitle: '여기서 /compact 실행（컨텍스트 압축）',
    softDelete: '\\u{1F5D1} 소프트 삭제（이 노드 이후 숨기기）',
    softDeleteTitle: '이 노드와 자손을 Fork Graph 표시에서만 숨깁니다. 데이터는 삭제되지 않으며 ☰ 메뉴에서 복원할 수 있습니다.',
    deletedBadge: '삭제됨', deletedTitle: '공식 UI에서 삭제(숨김)된 세션입니다. 데이터는 남아 있으며 CLI로 열 수 있습니다.',
    pinned: 'pinned', notPinned: 'not pinned', pinTitle: '클릭하여 핀 전환', collapsedBadge: '\\u25B6 접힘',
    noSession: '이 노드에는 세션 정보가 없습니다', noNodes: '표시할 노드가 없습니다.', noTime: '（시간 정보 없음）',
    previewTag: '복원 미리보기', restoreHere: '\\u2934 이 가지 복원', restored: '복원했습니다',
    sessions: ' sessions', nodes: ' nodes', forks: ' forks',
    noteFallback: '현재 워크스페이스에 해당하는 프로젝트가 없어 최근 활동한 프로젝트를 표시합니다.',
    noteEmpty: '~/.claude/projects 에서 세션(.jsonl)을 찾지 못했습니다.',
    justNow: '방금', minAgo: '분 전', hourAgo: '시간 전', dayAgo: '일 전', moAgo: '개월 전', yrAgo: '년 전'
  }
};
let lang = 'en';
function t(k) { return (I18N[lang] && I18N[lang][k]) ?? I18N.en[k] ?? k; }

/* ============================================================
   データ
   ============================================================ */
let P = ${safeJson(initial)};
let nodes = [];
let byId = {};
let byKey = {};
let childrenOf = new Map();
let HIDDEN_SESSIONS = new Set();
let softDeletedKeys = new Set();
let softDeletedList = [];
const IS_PREVIEW = !!(P.preview && P.preview.focusKey);
const FOCUS_KEY = IS_PREVIEW ? P.preview.focusKey : null;

/* ============================================================
   UI 状態（安定キーで保持）
   ============================================================ */
const collapsedKeys = new Set();
let currentSelectedKey = null;
let searchText = '';
let dateFilter = ''; /* 'YYYY-MM-DD'（ローカル日付）。空なら無効 */
let timeFrom = '';   /* 'HH:MM'。空なら無効（MVP6+ 時刻検索） */
let timeTo = '';
let pinOnly = false;
let previewChars = 4;
let pendingPayload = null;
let openViaCli = false; /* Open の経路トグル（保存値は P.openViaCli から復元） */
/* カレンダーの表示状態（表示中の年月・チャットが存在する日付の集合） */
const today = new Date();
let calYear = today.getFullYear();
let calMonth = today.getMonth(); /* 0-11 */
let chatDates = new Set();
function localeOf(l) { return ({ en: 'en-US', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' })[l] || 'en-US'; }

/* ============================================================
   レイアウト定数（prototype-full.html と同一）
   ============================================================ */
const PILL_H = 24;
const ROW_H  = 56;
const MARGIN_X = 50;
const MARGIN_Y = 30;
const STUB_LEN = 22;
const CHAR_W = 10.5;
const PILL_PADDING = 14;
const PILL_MIN_W = 28;
const LANE_GAP = 24;

let pillW = computePillW();
let laneW = computeLaneW();
function computePillW() { return Math.max(PILL_MIN_W, previewChars * CHAR_W + PILL_PADDING); }
function computeLaneW() { return pillW + LANE_GAP; }

function laneColor(lane) {
  return getComputedStyle(document.documentElement).getPropertyValue('--lane-' + (lane % 18)).trim() || '#888';
}

/* ============================================================
   静的テキストの適用（言語切替時にも呼ぶ）
   ============================================================ */
function applyTexts() {
  document.getElementById('search-box').placeholder = t('searchPh');
  document.getElementById('date-btn').title = t('dateTitle');
  document.getElementById('date-clear').title = t('clearDate');
  document.getElementById('cal-clear').textContent = t('clearDate');
  updateDateBtn();
  renderCalendar();
  document.getElementById('h-project').textContent = t('hProject');
  document.getElementById('h-display').textContent = t('hDisplay');
  document.getElementById('l-chars').textContent = t('lChars');
  document.getElementById('h-language').textContent = t('hLanguage');
  document.getElementById('h-filter').textContent = t('hFilter');
  document.getElementById('l-pinonly').textContent = t('lPinOnly');
  document.getElementById('h-restore').textContent = t('hRestore');
  const tag = document.getElementById('preview-tag');
  tag.textContent = t('previewTag');
  tag.style.display = IS_PREVIEW ? '' : 'none';
  const rbtn = document.getElementById('preview-restore-btn');
  if (IS_PREVIEW && !rbtn.dataset.done) rbtn.textContent = t('restoreHere');
  rbtn.style.display = IS_PREVIEW ? '' : 'none';
}

/* ============================================================
   データ適用
   ============================================================ */
function applyData(payload) {
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains('memo-edit')) {
    pendingPayload = payload; /* メモ入力中はリロードを退避（blur 後に適用） */
    return;
  }
  P = payload;
  lang = P.lang || 'en';
  openViaCli = !!P.openViaCli;
  /* Reload Window 後の復元用（WebviewPanelSerializer がこの状態から建て直す） */
  vscode.setState({ projectDir: P.projectDir || null, focusKey: FOCUS_KEY });
  document.getElementById('lang-select').value = lang;
  nodes = P.nodes || [];
  byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  byKey = Object.fromEntries(nodes.map(n => [n.key, n]));
  HIDDEN_SESSIONS = new Set(P.hiddenSessions || []);
  softDeletedList = P.softDeleted || [];
  softDeletedKeys = new Set(softDeletedList.map(e => e.key));
  /* プレビューでは対象の枝を可視化する（他のソフトデリートは隠したまま） */
  if (IS_PREVIEW && FOCUS_KEY) softDeletedKeys.delete(FOCUS_KEY);

  const rowCache = {};
  function rowOf(n) {
    if (rowCache[n.id] !== undefined) return rowCache[n.id];
    const r = (n.parent && byId[n.parent]) ? rowOf(byId[n.parent]) + 1 : 0;
    rowCache[n.id] = r;
    return r;
  }
  nodes.forEach(n => { n.row = rowOf(n); });

  childrenOf = new Map();
  nodes.forEach(n => {
    if (!n.parent) return;
    if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
    childrenOf.get(n.parent).push(n);
  });

  /* カレンダーの「チャットがある日」マーカー用 */
  chatDates = new Set(nodes.filter(n => n.timestamp).map(n => localDateOf(n.timestamp)));

  /* プレビュー専用の出し分け */
  document.getElementById('menu-main-only').style.display = IS_PREVIEW ? 'none' : '';
  document.getElementById('menu-restore-block').style.display = IS_PREVIEW ? 'none' : '';

  applyTexts();
  renderMeta();
  renderNoteBanner();
  if (!IS_PREVIEW) {
    renderProjectSelect();
    renderRestoreList();
  }
  render();

  if (IS_PREVIEW && FOCUS_KEY && byKey[FOCUS_KEY] && !currentSelectedKey) {
    /* 初回: 対象ノードを自動選択し、接続位置へスクロール */
    select(FOCUS_KEY);
    const g = document.querySelector('.node[data-key="' + FOCUS_KEY + '"]');
    if (g && g.scrollIntoView) g.scrollIntoView({ block: 'center', inline: 'center' });
  } else if (currentSelectedKey && byKey[currentSelectedKey] && !isHiddenByState(byKey[currentSelectedKey])) {
    select(currentSelectedKey);
  } else {
    deselect();
  }
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'data') applyData(e.data.payload);
});

function renderMeta() {
  const numForks = new Set(nodes.filter(n => n.parent && byId[n.parent] && byId[n.parent].lane !== n.lane).map(n => n.lane)).size;
  document.getElementById('meta').innerHTML =
    'Project: <strong>' + escapeHtml(P.projectLabel || '') + '</strong> · ' +
    (P.sessionCount || 0) + t('sessions') + ' · ' + nodes.length + t('nodes') + ' · ' + numForks + t('forks');
}

function renderNoteBanner() {
  const el = document.getElementById('note-banner');
  if (P.noteCode === 'fallback') { el.textContent = t('noteFallback'); el.style.display = ''; }
  else if (P.noteCode === 'empty') { el.textContent = t('noteEmpty'); el.style.display = ''; }
  else { el.style.display = 'none'; }
}

function renderProjectSelect() {
  const sel = document.getElementById('project-select');
  sel.innerHTML = '';
  (P.projects || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.dir;
    opt.textContent = p.label + '（' + relTime(p.mtime) + '）';
    if (p.dir === P.projectDir) opt.selected = true;
    sel.appendChild(opt);
  });
}
document.getElementById('project-select').addEventListener('change', (e) => {
  vscode.postMessage({ type: 'switchProject', dir: e.target.value });
});

/* MVP6: 復元リスト（＋MVP6+: プレビューを別タブで開く） */
function renderRestoreList() {
  const el = document.getElementById('restore-list');
  el.innerHTML = '';
  if (!softDeletedList.length) {
    el.innerHTML = '<div class="restore-empty">' + escapeHtml(t('restoreEmpty')) + '</div>';
    return;
  }
  softDeletedList.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'restore-item';
    const snip = document.createElement('span');
    snip.className = 'snippet';
    snip.textContent = entry.prompt || entry.key;
    snip.title = entry.prompt || '';
    const pv = document.createElement('button');
    pv.className = 'preview';
    pv.textContent = t('previewBtn');
    pv.addEventListener('click', () => {
      vscode.postMessage({ type: 'openPreview', key: entry.key });
    });
    const btn = document.createElement('button');
    btn.className = 'restore';
    btn.textContent = t('restore');
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'restoreNode', key: entry.key });
      softDeletedKeys.delete(entry.key);
      softDeletedList = softDeletedList.filter(x => x.key !== entry.key);
      renderRestoreList();
      render();
    });
    row.appendChild(snip);
    row.appendChild(pv);
    row.appendChild(btn);
    el.appendChild(row);
  });
}

/* ============================================================
   可視判定
   ============================================================ */
function isSoftDeleted(n) {
  let cur = n;
  while (cur) {
    if (softDeletedKeys.has(cur.key)) return true;
    cur = cur.parent ? byId[cur.parent] : null;
  }
  return false;
}

function isAncestorCollapsed(n) {
  let pid = n.parent;
  while (pid) {
    const p = byId[pid];
    if (!p) break;
    if (collapsedKeys.has(p.key)) return true;
    pid = p.parent;
  }
  return false;
}

let pinKeep = new Set();
function recomputePinKeep() {
  pinKeep = new Set();
  if (!pinOnly) return;
  nodes.forEach(n => {
    if (!n.pinned) return;
    let cur = n;
    while (cur) {
      pinKeep.add(cur.key);
      cur = cur.parent ? byId[cur.parent] : null;
    }
  });
}

function isHiddenByState(n) {
  if (isSoftDeleted(n)) return true;
  if (isAncestorCollapsed(n)) return true;
  if (pinOnly && !pinKeep.has(n.key)) return true;
  return false;
}

function showToggle(n) {
  if ((childrenOf.get(n.id) || []).length >= 2) return true;
  if (n.parent && (childrenOf.get(n.parent) || []).length >= 2) return true;
  return false;
}

/* MVP6 検索＋MVP6+ 日時検索（AND 条件。ヒット以外は薄暗く） */
function localDateOf(iso) {
  const tms = Date.parse(iso);
  if (!isFinite(tms)) return '';
  const d = new Date(tms);
  const pad = (v) => String(v).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function localTimeOf(iso) {
  const tms = Date.parse(iso);
  if (!isFinite(tms)) return '';
  const d = new Date(tms);
  const pad = (v) => String(v).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function matchesSearch(n) {
  if (searchText) {
    const q = searchText.toLowerCase();
    if (!((n.prompt || '').toLowerCase().includes(q) || (n.memo || '').toLowerCase().includes(q))) return false;
  }
  if (dateFilter) {
    if (!n.timestamp || localDateOf(n.timestamp) !== dateFilter) return false;
  }
  /* 時刻範囲（HH:MM の辞書順比較。日付未指定なら全日付に対して時間帯で絞る） */
  if (timeFrom || timeTo) {
    if (!n.timestamp) return false;
    const tm = localTimeOf(n.timestamp);
    if (timeFrom && tm < timeFrom) return false;
    if (timeTo && tm > timeTo) return false;
  }
  return true;
}
function filterActive() { return !!(searchText || dateFilter || timeFrom || timeTo); }

/* ============================================================
   レーン圧縮
   ============================================================ */
let laneMap = new Map();
let currentSvgW = 0;

function recomputeLayout() {
  pillW = computePillW();
  laneW = computeLaneW();
  recomputePinKeep();
  const visible = nodes.filter(n => !isHiddenByState(n));
  const used = Array.from(new Set(visible.map(n => n.lane))).sort((a, b) => a - b);
  laneMap = new Map(used.map((lane, idx) => [lane, idx]));
  currentSvgW = MARGIN_X + Math.max(0, used.length - 1) * laneW + 100;
}

function pos(n) {
  const mapped = laneMap.get(n.lane) ?? 0;
  return { x: MARGIN_X + mapped * laneW, y: MARGIN_Y + n.row * ROW_H };
}

const graphEl = document.getElementById('graph');
const svg = document.createElementNS(SVGNS, 'svg');
graphEl.appendChild(svg);

/* プレビュー: 対象枝（focus とその子孫）の集合 */
function inFocusBranch(n) {
  if (!IS_PREVIEW || !FOCUS_KEY) return false;
  let cur = n;
  while (cur) {
    if (cur.key === FOCUS_KEY) return true;
    cur = cur.parent ? byId[cur.parent] : null;
  }
  return false;
}

/* ============================================================
   描画
   ============================================================ */
function render() {
  if (!nodes.length) {
    svg.setAttribute('width', 0); svg.setAttribute('height', 0);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    let empty = document.getElementById('empty-msg');
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'empty-msg';
      empty.className = 'empty';
      graphEl.appendChild(empty);
    }
    empty.textContent = t('noNodes');
    return;
  }
  const emptyMsg = document.getElementById('empty-msg');
  if (emptyMsg) emptyMsg.remove();

  recomputeLayout();
  const maxRow = Math.max(...nodes.map(n => n.row));
  const svgH = MARGIN_Y * 2 + maxRow * ROW_H + 20;
  svg.setAttribute('width', currentSvgW);
  svg.setAttribute('height', svgH);

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  for (const [origLane, idx] of laneMap.entries()) {
    const line = document.createElementNS(SVGNS, 'line');
    const x = MARGIN_X + idx * laneW;
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.setAttribute('y1', MARGIN_Y - 10);
    line.setAttribute('y2', svgH - MARGIN_Y / 2);
    line.setAttribute('stroke', laneColor(origLane));
    line.setAttribute('stroke-width', 1);
    line.setAttribute('opacity', 0.12);
    svg.appendChild(line);
  }

  const HALF_H = PILL_H / 2;
  nodes.filter(n => n.parent && byId[n.parent]).forEach(n => {
    const p = byId[n.parent];
    if (collapsedKeys.has(p.key)) return;
    if (isHiddenByState(p) || isHiddenByState(n)) return;

    const cp = pos(p), cc = pos(n);
    const py = cp.y + HALF_H;
    const cy = cc.y - HALF_H;
    const path = document.createElementNS(SVGNS, 'path');
    let d;
    if (cp.x === cc.x) {
      d = 'M ' + cp.x + ' ' + py + ' L ' + cc.x + ' ' + cy;
    } else {
      const elbowY = py + (cy - py) * 0.5;
      d = 'M ' + cp.x + ' ' + py +
          ' L ' + cp.x + ' ' + (elbowY - 10) +
          ' Q ' + cp.x + ' ' + elbowY + ', ' + (cp.x + (cc.x - cp.x) * 0.3) + ' ' + elbowY +
          ' L ' + cc.x + ' ' + elbowY +
          ' L ' + cc.x + ' ' + cy;
    }
    const dim = filterActive() && !(matchesSearch(p) || matchesSearch(n));
    path.setAttribute('d', d);
    path.setAttribute('class', 'edge' + (dim ? ' dim' : ''));
    path.setAttribute('stroke', laneColor(n.lane));
    svg.appendChild(path);

    if (n.compacted) {
      /* /compact の実行位置: 子ノード直前の縦区間を 2 重波線で交差させる */
      const my = (cp.x === cc.x) ? (py + cy) / 2 : cy - 8;
      svg.appendChild(compactMark(cc.x, my, laneColor(n.lane), dim));
    }
  });

  let hitCount = 0;
  nodes.forEach(n => {
    if (isHiddenByState(n)) return;

    const isSelf = collapsedKeys.has(n.key);
    const hit = matchesSearch(n);
    if (filterActive() && hit) hitCount++;
    const { x, y } = pos(n);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'node'
      + (isSelf ? ' collapsed-self' : '')
      + (n.key === currentSelectedKey ? ' selected' : '')
      + (filterActive() && !hit ? ' dim' : '')
      + (inFocusBranch(n) ? ' focus-branch' : ''));
    g.setAttribute('data-key', n.key);
    g.setAttribute('transform', 'translate(' + x + ', ' + y + ')');

    const color = laneColor(n.lane);
    const preview = previewChars === 0 ? '' : (n.prompt || '').slice(0, previewChars);

    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('class', 'node-pill');
    rect.setAttribute('x', -pillW / 2);
    rect.setAttribute('y', -PILL_H / 2);
    rect.setAttribute('width', pillW);
    rect.setAttribute('height', PILL_H);
    rect.setAttribute('rx', PILL_H / 2);
    rect.setAttribute('fill', 'var(--bg)');
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', 1.5);
    if (n.session && HIDDEN_SESSIONS.has(n.session)) {
      rect.setAttribute('stroke-dasharray', '4 3'); /* 公式 UI で削除（非表示化）されたセッション */
    }
    g.appendChild(rect);

    if (preview) {
      const text = document.createElementNS(SVGNS, 'text');
      text.setAttribute('class', 'node-label');
      text.setAttribute('x', 0);
      text.setAttribute('y', 4);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', color);
      text.textContent = preview;
      g.appendChild(text);
    }

    if (n.pinned) {
      const pin = document.createElementNS(SVGNS, 'text');
      pin.setAttribute('class', 'badge-icon');
      pin.setAttribute('x', -8);
      pin.setAttribute('y', -PILL_H / 2 - 3);
      pin.setAttribute('text-anchor', 'end');
      pin.setAttribute('fill', color);
      pin.textContent = '★';
      g.appendChild(pin);
    }

    if (showToggle(n)) {
      const toggle = document.createElementNS(SVGNS, 'text');
      toggle.setAttribute('class', 'toggle-icon');
      toggle.setAttribute('x', 8);
      toggle.setAttribute('y', -PILL_H / 2 - 3);
      toggle.setAttribute('text-anchor', 'start');
      toggle.setAttribute('fill', color);
      toggle.textContent = isSelf ? '▶' : '▼';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse(n.key);
      });
      g.appendChild(toggle);
    }

    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = (n.prompt || '')
      + (n.timestamp ? '\\n\\n' + fmtWhen(n.timestamp) : '')
      + (n.memo ? '\\n[' + t('memo') + '] ' + n.memo : '');
    g.appendChild(title);

    g.addEventListener('click', () => select(n.key));
    svg.appendChild(g);

    if (isSelf) {
      const stub = document.createElementNS(SVGNS, 'path');
      stub.setAttribute('d', 'M ' + x + ' ' + (y + HALF_H) + ' L ' + x + ' ' + (y + HALF_H + STUB_LEN));
      stub.setAttribute('class', 'edge-stub');
      stub.setAttribute('stroke', color);
      svg.appendChild(stub);
    }
  });

  document.getElementById('search-count').textContent =
    filterActive() ? hitCount + t('hits') : '';
}

/* /compact 実行位置のマーカー（エッジに交差する 2 重波線。間にエッジを隠す帯を敷き、
   軸の省略記号 ≈ のように「ここで履歴が圧縮された」と読めるようにする） */
function compactMark(x, y, color, dim) {
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'compact-mark' + (dim ? ' dim' : ''));
  const w = 8; /* 波 1 つの幅。全幅 2w でエッジを横断する */
  const gap = document.createElementNS(SVGNS, 'rect');
  gap.setAttribute('x', x - w - 2);
  gap.setAttribute('y', y - 4);
  gap.setAttribute('width', w * 2 + 4);
  gap.setAttribute('height', 8);
  gap.setAttribute('fill', 'var(--bg)');
  g.appendChild(gap);
  for (const dy of [-2.5, 2.5]) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M ' + (x - w) + ' ' + (y + dy)
      + ' q ' + (w / 2) + ' -4 ' + w + ' 0'
      + ' q ' + (w / 2) + ' 4 ' + w + ' 0');
    p.setAttribute('stroke', color);
    g.appendChild(p);
  }
  const title = document.createElementNS(SVGNS, 'title');
  title.textContent = t('compactTitle');
  g.appendChild(title);
  return g;
}

function toggleCollapse(key) {
  if (collapsedKeys.has(key)) collapsedKeys.delete(key);
  else collapsedKeys.add(key);
  render();
}

/* ============================================================
   時刻表示
   ============================================================ */
function relTime(input) {
  const tm = typeof input === 'number' ? input : Date.parse(input);
  if (!isFinite(tm)) return '';
  const diff = Date.now() - tm;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('justNow');
  if (m < 60) return m + t('minAgo');
  const h = Math.floor(m / 60);
  if (h < 24) return h + t('hourAgo');
  const d = Math.floor(h / 24);
  if (d < 30) return d + t('dayAgo');
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + t('moAgo');
  return Math.floor(mo / 12) + t('yrAgo');
}

function fmtWhen(iso) {
  const tm = Date.parse(iso);
  if (!isFinite(tm)) return '';
  const dt = new Date(tm);
  const pad = (v) => String(v).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) +
    ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + '（' + relTime(tm) + '）';
}

/* ============================================================
   詳細パネル(右)
   ============================================================ */
function deselect() {
  currentSelectedKey = null;
  document.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
  document.getElementById('detail').innerHTML = '';
  document.querySelector('main').classList.add('no-detail');
}

function persist(n) {
  vscode.postMessage({ type: 'saveNote', key: n.key, memo: n.memo || '', pinned: !!n.pinned });
}

function select(key) {
  const n = byKey[key];
  if (!n) { deselect(); return; }
  currentSelectedKey = key;
  document.querySelector('main').classList.remove('no-detail');
  document.querySelectorAll('.node').forEach(el => el.classList.toggle('selected', el.dataset.key === key));

  const isHidden = !!(n.session && HIDDEN_SESSIONS.has(n.session));
  const badges = [
    '<span class="badge" style="color:' + laneColor(n.lane) + ';border-color:' + laneColor(n.lane) + '">lane-' + n.lane + '</span>',
    '<span class="badge pin-toggle ' + (n.pinned ? 'on' : 'off') + '" title="' + escapeHtml(t('pinTitle')) + '">★ ' + (n.pinned ? t('pinned') : t('notPinned')) + '</span>',
    n.memo ? '<span class="badge" style="color:var(--memo);border-color:var(--memo)">memo</span>' : '',
    collapsedKeys.has(key) ? '<span class="badge" style="color:var(--fg-dim);border-color:var(--fg-dim)">' + t('collapsedBadge') + '</span>' : '',
    isHidden ? '<span class="badge" style="color:#f48771;border-color:#f48771" title="' + escapeHtml(t('deletedTitle')) + '">' + escapeHtml(t('deletedBadge')) + '</span>' : '',
    n.compacted ? '<span class="badge" title="' + escapeHtml(t('compactTitle')) + '">\\u2248 compact</span>' : '',
    n.session ? '<span class="badge" title="' + escapeHtml(n.session) + '">' + escapeHtml(n.session.slice(0, 8)) + '</span>' : '',
  ].filter(Boolean).join('');

  document.getElementById('detail').innerHTML =
    '<button class="close-btn" title="×">×</button>' +
    '<h2>' + escapeHtml(t('selected')) + '</h2>' +
    '<div class="badges">' + badges + '</div>' +
    '<h3>' + escapeHtml(t('prompt')) + '</h3>' +
    '<div class="prompt-full">' + escapeHtml(n.prompt || '') + '</div>' +
    '<h3>' + escapeHtml(t('when')) + '</h3>' +
    '<div class="when">' + (n.timestamp ? escapeHtml(fmtWhen(n.timestamp)) : '<span class="rel">' + escapeHtml(t('noTime')) + '</span>') + '</div>' +
    '<h3>' + escapeHtml(t('memo')) + '</h3>' +
    '<textarea class="memo-edit" placeholder="' + escapeHtml(t('memoPh')) + '">' + escapeHtml(n.memo || '') + '</textarea>' +
    '<div><button class="memo-save">' + escapeHtml(t('saveMemo')) + '</button><span class="save-state"></span></div>' +
    '<button class="open-btn"' + (n.session ? '' : ' disabled') + '></button>' +
    '<label class="open-cli-row"><input type="checkbox" class="open-cli-check"> <span class="open-cli-label"></span></label>' +
    (IS_PREVIEW ? '' :
      '<button class="soft-delete-btn" title="' + escapeHtml(t('softDeleteTitle')) + '">' + t('softDelete') + '</button>') +
    (n.session ? '' : '<div class="empty-state">' + escapeHtml(t('noSession')) + '</div>');

  document.querySelector('aside .close-btn').addEventListener('click', deselect);
  document.querySelector('aside .pin-toggle').addEventListener('click', () => {
    n.pinned = !n.pinned;
    persist(n);
    render();
    select(key);
  });
  const memoEdit = document.querySelector('aside .memo-edit');
  const saveBtn = document.querySelector('aside .memo-save');
  const saveSt = document.querySelector('aside .save-state');
  const doSave = () => {
    n.memo = memoEdit.value;
    persist(n);
    render();
    document.querySelectorAll('.node').forEach(el => el.classList.toggle('selected', el.dataset.key === key));
    saveSt.textContent = t('saved');
    setTimeout(() => { saveSt.textContent = ''; }, 1500);
  };
  saveBtn.addEventListener('click', doSave);
  memoEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave();
  });
  memoEdit.addEventListener('blur', () => {
    if (pendingPayload) {
      const p = pendingPayload;
      pendingPayload = null;
      applyData(p);
    }
  });
  /* Open の経路: 削除済み・別フォルダは CLI 固定。それ以外はトグルで公式拡張 / CLI を選べる */
  const openBtn = document.querySelector('aside .open-btn');
  const cliRow = document.querySelector('aside .open-cli-row');
  const cliCheck = document.querySelector('aside .open-cli-check');
  const cliLabel = document.querySelector('aside .open-cli-label');
  const forcedCli = isHidden || P.foreign;
  const refreshOpenUi = () => {
    const useCli = forcedCli || openViaCli;
    openBtn.textContent = isHidden ? t('openCli')
      : P.foreign ? t('openCliForeign')
      : (useCli ? t('openBtnCli') : t('openBtn'));
    cliCheck.checked = useCli;
    cliCheck.disabled = forcedCli;
    cliLabel.textContent = t('cliToggle') + (forcedCli ? ' ' + t('cliForced') : '');
    cliRow.classList.toggle('forced', forcedCli);
  };
  refreshOpenUi();
  cliCheck.addEventListener('change', (e) => {
    openViaCli = !!e.target.checked;
    vscode.postMessage({ type: 'setOpenViaCli', value: openViaCli }); /* 好みとして永続化 */
    refreshOpenUi();
  });
  if (n.session) {
    openBtn.addEventListener('click', () => {
      const useCli = forcedCli || openViaCli;
      vscode.postMessage({
        type: useCli ? 'openSessionCli' : 'openSession',
        sessionId: n.session,
        cwd: useCli ? P.projectCwd : undefined
      });
    });
  }
  const sdBtn = document.querySelector('aside .soft-delete-btn');
  if (sdBtn) {
    sdBtn.addEventListener('click', () => {
      const snippet = (n.prompt || '').replace(/\\s+/g, ' ').slice(0, 60);
      vscode.postMessage({ type: 'softDelete', key: n.key, prompt: snippet });
      softDeletedKeys.add(n.key);
      softDeletedList.unshift({ key: n.key, prompt: snippet, deletedAt: new Date().toISOString() });
      deselect();
      renderRestoreList();
      render();
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ============================================================
   ヘッダー（検索・日付）・メニュー・プレビュー復元
   ============================================================ */
const menuBtn = document.getElementById('menu-btn');
const menuPanel = document.getElementById('menu-panel');
const charsSlider = document.getElementById('chars-slider');
const charsDisplay = document.getElementById('chars-display');
const searchBox = document.getElementById('search-box');
const dateBtn = document.getElementById('date-btn');
const dateClear = document.getElementById('date-clear');
const calPanel = document.getElementById('cal-panel');
const timeFromEl = document.getElementById('time-from');
const timeToEl = document.getElementById('time-to');
const pinOnlyCheck = document.getElementById('pin-only');
const langSelect = document.getElementById('lang-select');

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = menuPanel.classList.toggle('open');
  menuBtn.classList.toggle('active', open);
});

document.addEventListener('click', (e) => {
  if (!menuPanel.contains(e.target) && e.target !== menuBtn) {
    menuPanel.classList.remove('open');
    menuBtn.classList.remove('active');
  }
  if (!calPanel.contains(e.target) && e.target !== dateBtn) {
    calPanel.classList.remove('open');
  }
});

charsSlider.addEventListener('input', (e) => {
  previewChars = parseInt(e.target.value, 10);
  charsDisplay.textContent = previewChars;
  render();
});

searchBox.addEventListener('input', (e) => {
  searchText = e.target.value.trim();
  render();
});

/* ============================================================
   MVP6+: 自前カレンダー（日付＋時刻検索）
   内蔵 input[type=date] はブラウザのロケール固定で言語切替に追従できないため、
   月名・曜日を Intl で生成する自前カレンダーに置き換えた。
   チャットが存在する日には ● マーカーを付ける。
   ============================================================ */
function pad2(v) { return String(v).padStart(2, '0'); }

function updateDateBtn() {
  let label = '\\u{1F4C5}';
  if (dateFilter) label += ' ' + dateFilter;
  if (timeFrom || timeTo) label += ' ' + (timeFrom || '00:00') + '\\u2013' + (timeTo || '23:59');
  dateBtn.textContent = label;
  dateBtn.classList.toggle('active', !!(dateFilter || timeFrom || timeTo));
  dateClear.style.display = (dateFilter || timeFrom || timeTo) ? '' : 'none';
}

function renderCalendar() {
  const loc = localeOf(lang);
  /* タイトル（例: June 2026 / 2026年6月 / 2026년 6월） */
  document.getElementById('cal-title').textContent =
    new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'long' }).format(new Date(calYear, calMonth, 1));

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  /* 曜日ヘッダ（日曜始まり。Intl の narrow 表記でロケール追従） */
  const dowFmt = new Intl.DateTimeFormat(loc, { weekday: 'narrow' });
  for (let i = 0; i < 7; i++) {
    const el = document.createElement('div');
    el.className = 'dow';
    el.textContent = dowFmt.format(new Date(2023, 0, 1 + i)); /* 2023-01-01 は日曜 */
    grid.appendChild(el);
  }
  const first = new Date(calYear, calMonth, 1);
  const start = new Date(calYear, calMonth, 1 - first.getDay()); /* 直前の日曜 */
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const el = document.createElement('div');
    el.className = 'day'
      + (d.getMonth() !== calMonth ? ' out' : '')
      + (iso === dateFilter ? ' selected' : '')
      + (chatDates.has(iso) ? ' has-chat' : '');
    el.textContent = d.getDate();
    el.addEventListener('click', () => {
      dateFilter = (dateFilter === iso) ? '' : iso; /* 同じ日を再クリックで解除 */
      updateDateBtn();
      renderCalendar();
      render();
    });
    grid.appendChild(el);
  }
}

dateBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  calPanel.classList.toggle('open');
});
document.getElementById('cal-prev').addEventListener('click', () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});
document.getElementById('cal-next').addEventListener('click', () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});
timeFromEl.addEventListener('input', (e) => {
  timeFrom = e.target.value || '';
  updateDateBtn();
  render();
});
timeToEl.addEventListener('input', (e) => {
  timeTo = e.target.value || '';
  updateDateBtn();
  render();
});
function clearDateFilter() {
  dateFilter = '';
  timeFrom = '';
  timeTo = '';
  timeFromEl.value = '';
  timeToEl.value = '';
  updateDateBtn();
  renderCalendar();
  render();
}
document.getElementById('cal-clear').addEventListener('click', clearDateFilter);
dateClear.addEventListener('click', clearDateFilter);

pinOnlyCheck.addEventListener('change', (e) => {
  pinOnly = !!e.target.checked;
  render();
});

/* MVP6+: 言語切替（globalState に保存して次回以降も維持） */
langSelect.addEventListener('change', (e) => {
  lang = e.target.value;
  vscode.postMessage({ type: 'setLang', lang });
  applyTexts(); /* カレンダー（月名・曜日）も Intl で言語追従 */
  renderMeta();
  renderNoteBanner();
  if (!IS_PREVIEW) {
    renderRestoreList();
    renderProjectSelect(); /* ✏️ 修正: フォルダ一覧の相対時刻（〇日前）が旧言語のままだった */
  }
  render();
  if (currentSelectedKey) select(currentSelectedKey);
});

/* MVP6+: プレビューからの復元 */
document.getElementById('preview-restore-btn').addEventListener('click', (e) => {
  if (!FOCUS_KEY) return;
  vscode.postMessage({ type: 'restoreNode', key: FOCUS_KEY });
  const btn = e.target;
  btn.textContent = t('restored');
  btn.dataset.done = '1';
  btn.disabled = true;
});

/* 初期表示 */
applyData(P);
</script>

</body>
</html>`;
}
