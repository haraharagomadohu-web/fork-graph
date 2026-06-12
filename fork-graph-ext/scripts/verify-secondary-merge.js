// 二次結合（S1 §10.3）の実データ検証スクリプト
// 実行: node scripts/verify-secondary-merge.js（事前に npm run compile）
//
// 確認すること:
//  1. 再スタンプされた既知の複製ペア（715448d0 の 08:36:24.467Z ↔ d8b477e8 の 03:34:54.676Z）が
//     1 つの canonical ノードに併合されていること
//  2. canonical DAG に「親が存在しない（dangling）」レコードが無いこと（alias 解決の検証）
//  3. 「同じ親・同じ内容の assistant 兄弟」（= 再スタンプ複製の取りこぼし）が残っていないこと
const path = require("path");
const os = require("os");
const fs = require("fs");
const { canonicalize, loadProjectAsForest } = require("../out/sessionLoader.js");

const dir = path.join(
  os.homedir(),
  ".claude/projects/c--Users-natum-Desktop-claude-app-fork-graph"
);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => path.join(dir, f));

const { recs } = canonicalize(files);
console.log(`canonical records: ${recs.size} (from ${files.length} files)`);

// --- 1. 既知の再スタンプ複製ペアが併合されているか ---
// 併合後は「オリジナルの timestamp（03:34:54.676Z）を持つ 1 ノード」だけが残り、
// 再スタンプ側（08:36:24.467Z）の複製は消えているはず
let orig = 0, restamped = 0;
for (const r of recs.values()) {
  if (r.type !== "assistant") continue;
  if (r.timestamp === "2026-06-05T03:34:54.676Z") orig++;
  if (r.timestamp === "2026-06-05T08:36:24.467Z" && r.requestId === "req_011CbjQoXZPFNRgMp8DbWaes") restamped++;
}
console.log(`known pair: original(03:34:54)=${orig}, restamped copy(08:36:24)=${restamped}  ` +
  (orig === 1 && restamped === 0 ? "OK (merged)" : "NG"));

// --- 2. dangling parent が無いか ---
let dangling = 0;
for (const r of recs.values()) {
  if (r.parentUuid != null && !recs.has(r.parentUuid)) dangling++;
}
console.log(`dangling parents: ${dangling}  ` + (dangling === 0 ? "OK" : "NG"));

// --- 3. 取りこぼし（同じ親・同型・同内容の兄弟）が残っていないか ---
// 内容指紋は本体実装の fingerprint() と同じ優先順で計算する
// （attachment は message を持たないため、message.content だけ見ると全 attachment が同一視されてしまう）
const sig = (r) =>
  r.message !== undefined
    ? JSON.stringify(r.message.content)
    : r.attachment !== undefined
      ? JSON.stringify(r.attachment)
      : String(r.subtype || "");
const byParent = new Map();
for (const r of recs.values()) {
  const k = r.parentUuid + "|" + r.type + "|" + sig(r);
  byParent.set(k, (byParent.get(k) || 0) + 1);
}
const leftovers = [...byParent.values()].filter((n) => n > 1).length;
console.log(`identical siblings (same parent+type+content): ${leftovers}  ` +
  (leftovers === 0 ? "OK" : "NG (要確認: 安定IDが無い型の複製か偶然の同一内容)"));

// --- 参考: 森の最終出力 ---
const { nodes } = loadProjectAsForest(dir);
const lanes = new Set(nodes.map((n) => n.lane)).size;
const roots = nodes.filter((n) => n.parent === null).length;
console.log(`forest: ${nodes.length} user nodes, ${lanes} lanes, ${roots} roots`);
