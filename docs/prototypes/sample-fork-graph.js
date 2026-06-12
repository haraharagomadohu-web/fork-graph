/* ============================================================
   多大な Fork 構造サンプル
   想定: React アプリ開発で発生した 42 セッション

   レーン割り当ての原則:
   「最もひ孫のひが多いところから優先して親に隣接」
   = 深い系統ほど親の隣レーンに配置する。
     浅い系統は遠いレーンに押し出される(トレードオフ)。

   構造の特徴(描画の厳密性を試すために意図的に含めたもの):
   - parent: null のルートが 4 つ(独立した会話系譜)
   - m1 から 4 Fork(同じ親からの最大 Fork 数)
   - m2 から 3 Fork
   - 🌿 孫レベル Fork(row 2 のノードが枝分かれする)を多数:
       * m3 → au1 → au2  (深 2 / 認証ライブラリ比較)
       * s1 → ss1 → ss2  (深 2 / RTK Query 単独検証)
       * v2 → vv1         (深 1 / snapshot testing)
       * f2 → fr1         (深 1 / route-based code splitting)
       * t2 → tt1         (深 1 / Framer Motion)
   - ひ孫レベル Fork: s2 → sg1, t1 → c1, v1 → p1, f1 → ff1
   - 18 レーン、最大深さ 7 行
   ============================================================ */
window.SAMPLE_NODES = [
  /* ============================================================
     ルート 1: React アプリ全体方針(大きな木)
     ============================================================ */
  { id: 'm1', parent: null, lane: 0, prompt: 'Reactアプリの方針を相談したい',         pinned: false, memo: '' },

  /* main 続き (lane 0) */
  { id: 'm2', parent: 'm1', lane: 0, prompt: 'ディレクトリ構成を決める',               pinned: false, memo: '' },
  { id: 'm3', parent: 'm2', lane: 0, prompt: '認証どうするか',                         pinned: false, memo: '' },
  { id: 'm4', parent: 'm3', lane: 0, prompt: 'TanStack Routerを試す',                  pinned: false, memo: '' },
  { id: 'm5', parent: 'm4', lane: 0, prompt: 'ベースが固まった',                       pinned: true,  memo: 'ベースが固まった瞬間。\nデザインも実装も方向が見えた。' },
  { id: 'm6', parent: 'm5', lane: 0, prompt: 'APIエラー処理の方針',                    pinned: false, memo: '' },
  { id: 'm7', parent: 'm6', lane: 0, prompt: 'モバイル対応の設計',                     pinned: false, memo: '' },

  /* 🌿 孫レベル Fork: 認証ライブラリ比較 (lane 1) — m3 の Fork */
  { id: 'au1', parent: 'm3', lane: 1, prompt: 'Auth0を試す',                            pinned: false, memo: '' },
  { id: 'au2', parent: 'au1', lane: 1, prompt: 'Clerkに決定',                           pinned: true,  memo: 'Clerk の UI コンポーネントが思想に合った。' },

  /* sub-Fork: RTK (lane 2) — m2 の Fork(深い系統) */
  { id: 's1', parent: 'm2', lane: 2, prompt: 'Reduxを試す',                            pinned: false, memo: '' },
  { id: 's2', parent: 's1', lane: 2, prompt: 'RTKに移行',                              pinned: true,  memo: 'createSlice と RTK Query の組み合わせがハマった。' },
  { id: 's3', parent: 's2', lane: 2, prompt: 'createSliceの実装',                      pinned: false, memo: '' },
  { id: 's5', parent: 's3', lane: 2, prompt: 'selectorの最適化',                       pinned: false, memo: 'reselect の memoize 効果がはっきり見えた。' },

  /* ひ孫レベル Fork: redux-saga 比較 (lane 3) — s2 の Fork
     分岐が遅い(row 4 で分岐)ので親レーンの隣に配置 → s2→sg1 が横切らない */
  { id: 'sg1', parent: 's2', lane: 3, prompt: 'redux-sagaと比較',                      pinned: false, memo: '結局 RTK Query で十分だった。' },

  /* 🌿 孫レベル Fork: RTK Query 単独検証 (lane 4) — s1 の Fork
     分岐が早い(row 3 で分岐)ので外側に配置 → エッジは sg1 の上を通って交差しない */
  { id: 'ss1', parent: 's1', lane: 4, prompt: 'RTK Queryを単独で',                     pinned: false, memo: '' },
  { id: 'ss2', parent: 'ss1', lane: 4, prompt: '大規模APIで採用',                      pinned: true,  memo: 'キャッシュ戦略とinvalidationが綺麗に決まった。' },

  /* sub-Fork: Zustand (lane 5) — m2 の Fork */
  { id: 'z1', parent: 'm2', lane: 5, prompt: 'Zustandと比較したい',                    pinned: true,  memo: 'Redux との比較が綺麗にまとまった。' },
  { id: 'z2', parent: 'z1', lane: 5, prompt: 'persist middlewareの使い方',             pinned: false, memo: '' },
  { id: 'z3', parent: 'z2', lane: 5, prompt: 'Zustandに決定',                          pinned: true,  memo: '最終的に Zustand を採用。\nAPI の最小性が思想に合った。' },

  /* Fork: スタイリング Tailwind (lane 6) — m1 の Fork */
  { id: 't1', parent: 'm1', lane: 6, prompt: 'Tailwindセットアップ',                   pinned: false, memo: '' },
  { id: 't2', parent: 't1', lane: 6, prompt: 'デザイントークンの整理',                 pinned: false, memo: '' },
  { id: 't3', parent: 't2', lane: 6, prompt: 'dark mode対応',                          pinned: false, memo: 'prefers-color-scheme + class 両対応の落とし所。' },

  /* 🌿 孫レベル Fork: Framer Motion (lane 7) — t2 の Fork
     分岐が遅い(row 3 で分岐)ので親レーンの隣に配置 → t2→tt1 が横切らない */
  { id: 'tt1', parent: 't2', lane: 7, prompt: 'Framer Motion導入',                     pinned: false, memo: 'ページ遷移のアニメーションが綺麗に決まった。' },

  /* ひ孫レベル Fork: CSS-in-JS (lane 8) — t1 の Fork
     分岐が早い(row 2 で分岐)ので外側に配置 → エッジは tt1 の上を通って交差しない */
  { id: 'c1', parent: 't1', lane: 8, prompt: 'vanilla-extractを試す',                  pinned: false, memo: '' },
  { id: 'c2', parent: 'c1', lane: 8, prompt: '比較してTailwindに戻る',                 pinned: false, memo: '結局 Tailwind に戻る決断ができた。' },

  /* Fork: テスト Vitest (lane 9) — m1 の Fork */
  { id: 'v1', parent: 'm1', lane: 9, prompt: 'Vitestセットアップ',                     pinned: false, memo: '' },
  { id: 'v2', parent: 'v1', lane: 9, prompt: 'React Testing Library連携',              pinned: false, memo: '' },
  { id: 'v3', parent: 'v2', lane: 9, prompt: 'モックの整理',                           pinned: true,  memo: 'MSW でのモック方針が固まった。' },

  /* 🌿 孫レベル Fork: snapshot testing (lane 10) — v2 の Fork */
  { id: 'vv1', parent: 'v2', lane: 10, prompt: 'snapshot testing',                     pinned: false, memo: 'UIコンポーネントだけ限定的に採用。' },

  /* ひ孫レベル Fork: Playwright (lane 11) — v1 の Fork */
  { id: 'p1', parent: 'v1', lane: 11, prompt: 'E2Eテスト導入',                         pinned: false, memo: '' },
  { id: 'p2', parent: 'p1', lane: 11, prompt: 'CI連携',                                pinned: false, memo: '' },

  /* Fork: パフォーマンス (lane 12) — m1 の Fork */
  { id: 'f1', parent: 'm1', lane: 12, prompt: 'bundle分析',                            pinned: false, memo: '' },
  { id: 'f2', parent: 'f1', lane: 12, prompt: 'code splitting',                        pinned: false, memo: '' },
  { id: 'f3', parent: 'f2', lane: 12, prompt: '画像最適化',                            pinned: false, memo: 'LCP が 2.1秒 → 0.9秒 に改善。' },

  /* 🌿 孫レベル Fork: route-based splitting (lane 13) — f2 の Fork */
  { id: 'fr1', parent: 'f2', lane: 13, prompt: 'route-based分割',                      pinned: false, memo: 'ページ単位で分割し、初回ロード40%削減。' },

  /* ひ孫レベル Fork: Lighthouse CI (lane 14) — f1 の Fork */
  { id: 'ff1', parent: 'f1', lane: 14, prompt: 'Lighthouse CI導入',                    pinned: false, memo: 'Web Vitals を毎 PR で自動測定。' },

  /* ============================================================
     ルート 2: バックエンド設計(独立した会話系譜)
     ============================================================ */
  { id: 'b1', parent: null, lane: 15, prompt: 'バックエンドアーキテクチャ',            pinned: false, memo: '' },
  { id: 'b2', parent: 'b1', lane: 15, prompt: 'API設計',                               pinned: false, memo: 'REST と RPC のハイブリッド方針が固まった。' },
  { id: 'b3', parent: 'b2', lane: 15, prompt: 'DB選定',                                pinned: false, memo: '' },

  /* ============================================================
     ルート 3: 本番デプロイ(独立した会話系譜)
     ============================================================ */
  { id: 'd1', parent: null, lane: 16, prompt: '本番デプロイの方針',                    pinned: false, memo: '' },
  { id: 'd2', parent: 'd1', lane: 16, prompt: 'Cloudflare Pagesに決定',                pinned: true,  memo: 'デプロイ時間が 90秒 → 12秒 に短縮。' },

  /* ============================================================
     ルート 4: CI 環境構築(独立した会話系譜・単独ノード)
     ============================================================ */
  { id: 'ci1', parent: null, lane: 17, prompt: 'GitHub Actionsの土台',                 pinned: false, memo: '' },
];
