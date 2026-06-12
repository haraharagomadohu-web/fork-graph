// Fork Graph が実際に表示しているノード構造のダンプ（診断用）
// 実行: node scripts/dump-forest.js
const path = require("path");
const os = require("os");
const fs = require("fs");
const { loadProjectAsForest } = require("../out/sessionLoader.js");

const dir = path.join(
  os.homedir(),
  ".claude/projects/c--Users-natum-Desktop-claude-app-fork-graph"
);
const { nodes } = loadProjectAsForest(dir);

const byId = new Map(nodes.map((n) => [n.id, n]));
const children = new Map();
for (const n of nodes) {
  if (!children.has(n.parent)) children.set(n.parent, []);
  children.get(n.parent).push(n);
}

// 「すべての5ファイルを読み込んでください」で始まる木を探す
const roots = children.get(null) || [];
const target = roots.find((r) => r.prompt.startsWith("すべての5ファイル"));
if (!target) {
  console.log("target root not found. roots:");
  roots.forEach((r) => console.log(" -", r.prompt.slice(0, 60)));
  process.exit(1);
}

// 木をDFSでダンプ。lane / session / prompt 先頭を表示
const short = (s) => (s || "").replace(/\s+/g, " ").slice(0, 72);
const dump = (id, depth) => {
  const n = byId.get(id);
  const kids = (children.get(id) || []);
  console.log(
    `${"  ".repeat(depth)}[lane ${String(n.lane).padStart(2)}] (${(n.session || "?").slice(0, 8)}) ${short(n.prompt)}`
  );
  for (const k of kids) dump(k.id, depth + 1);
};
dump(target.id, 0);

// 主レーン（rootのlane）のノード数
const mainLane = target.lane;
const inTree = new Set();
const collect = (id) => {
  inTree.add(id);
  for (const k of children.get(id) || []) collect(k.id);
};
collect(target.id);
const mainCount = [...inTree].filter((id) => byId.get(id).lane === mainLane).length;
console.log(`\ntree total: ${inTree.size} nodes / main lane(${mainLane}): ${mainCount} nodes / branches: ${inTree.size - mainCount}`);
