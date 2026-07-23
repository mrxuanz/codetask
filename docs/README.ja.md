# codetask（AI タスクオーケストレーション）

言語ドキュメント:

- [English](../README.md)
- [中文](README.zh-CN.md)
- 日本語（このページ）

**計画を固めて離席。戻ってレビュー。**

codetask はソフトウェア納品向けのデスクトップ AI タスクオーケストレーションアプリです。チャットで要件草案を確定し、強いモデルが Coding Plan（Milestone → Slice → Task）に分解、実用的な Agent CLI が OS サンドボックス内で unattended 実行。戻ったら Tasks UI で進捗ツリー・証跡・失敗を確認し、再試行やチャットで不足を補完します。

![codetask Tasks 画面 — ジョブ進捗と Milestone / Slice / Task 実行ツリー](codetask-tasks-progress.png)

**Codex** / **Claude Code** / **OpenCode** / **Cursor CLI** に対応。**Electron** デスクトップ、または **Server** モードでブラウザから利用できます。

## 解決する課題

従来の「大きな 1 プロンプトで Agent を最後まで走らせる」方式は、長い要件で次の問題が起きやすいです。

- コンテキストが腐り、出力が意図からずれていく
- 途中レビューができず、戻ったときに最初からやり直しになる
- 計画と実行が同一モデルになり、コストと品質のバランスが取りにくい

codetask の方針：**人が方向を決め、強いモデルが計画し、実用的なモデルが実行し、人が戻って検収・補完する**。

典型的な利用シーン:

1. **出かける前** — チャットで要件草案を確定し、Agent CLI（Codex / Cursor CLI 等）を選び、Planner で Milestone → Slice → Task 計画を生成
2. **離席中** — ジョブキューが依存順に OS サンドボックス内で Task を実行。Slice / Milestone レベルの自動検証
3. **戻った後** — UI で進捗ツリー・証跡・失敗点を確認。ノード単位で計画確認、ブロックタスクの再試行、チャットで不足を補完

## 核心理念

### 計画と実行の分離（Control Plane）

| フェーズ        | ロール                                  | 推奨戦略                                         | 説明                                       |
| --------------- | --------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| チャット / 草案 | `conversation`                          | 強モデル + 読み取り専用                          | 要件整理、REQUIREMENTS CONTRACT の確定     |
| 計画生成        | `planner`                               | 強モデル + 読み取り専用                          | MCP で構造化計画とタスクコンテキストを登録 |
| タスク実行      | `task-worker`                           | 実用的 / 低コストモデル + サンドボックス書き込み | 各 Task は独立コンテキスト、約 10 分で完了 |
| 段階検証        | `slice-verifier` / `milestone-verifier` | 設定可能                                         | 読み取り専用検証 + 独立出力ディレクトリ    |

**設定 → Control Plane** で Planner / Verifier 用 CLI（Codex、Claude Code、OpenCode、Cursor CLI）を個別指定できます。草案の各 ability に実行用 `recommendedCoreCode` を指定し、「計画は強モデル、実行は実用モデル」を実現します。

### Coding Plan + SDK 実行層（コスト面で合理的）

長期のソフトウェア納品では、**Coding Plan**（Milestone → Slice → Task の構造化ジョブ）で Agent を動かす方が、アプリ内からモデル API を都度呼ぶより、しばしば安く合理的です。各 Task のコンテキストが絞られ、既存の CLI/SDK サブスクリプションを再利用でき、リクエストごとに膨らんだコンテキストを再送する必要もありません。

そのため codetask は生の HTTP API ではなく、**各 Agent SDK / CLI を実行層**（Codex SDK、Claude Agent SDK、OpenCode SDK、Cursor ACP）として採用しています。Provider は統一ランタイムに接続し、すでに使っているツールで計画キューを unattended 実行できます。

**小さな作業**なら**通常の会話**で十分です。Coding Plan の生成や Job の起動は不要です。構造化の Milestone → Slice → Task パイプラインは、unattended 実行のメリットがあり、コンテキスト腐敗しやすい長い要件向けに使います。

### 小タスク化とコンテキスト腐敗の防止（GSD 参考）

計画分解は GSD（Get Shit Done）を参考にしています。

```
Milestone（マイルストーン）
  └── Slice（デモ可能な垂直インクリメント）
        └── Task（1 回の Agent セッションで完了、~10 分）
```

Planner ルール（`src/server/planner/prompts.ts` 参照）:

- 無関係な変更を混ぜた巨大 Task より、小さな Task を多く分割
- 各 Task は MCP で**自己完結**コンテキストを登録（Read First / Files / Constraints / Do / Done When）
- 明確な `successCriteria`、`abilityCode`、`taskKind`、依存関係
- UI でノード単位のレビュー・編集・確認後に実行開始

### サンドボックス分離（Codex 参考）

Task Worker / Verifier は OS レベルサンドボックスで動作。[OpenAI Codex](https://github.com/openai/codex) のサンドボックス設計を参考に、`native/vendor/codex-rs` と自前 `codeteam-*` crate で実装:

- **Planner / チャット** — 外側 OS サンドボックスなし。SDK/ACP 層は読み取り専用
- **Task Worker** — ワークスペース書き込み可、ホスト FS 読み取り専用、独立 `runtimeRoot`
- **Fail closed** — サンドボックス helper またはポリシー失敗時は即終了。通常 `spawn()` へフォールバックしない

## ワークフロー

```
草案チャット → REQUIREMENTS CONTRACT 確定 → Planner が計画生成
    → レビュー / 編集 / ノード確認 → Job 開始
        → Task Worker（サンドボックス）→ Slice 検証 → Milestone 検証
            → 完了 / ブロック再試行 → 戻ってチャットで補完
```

1. **草案** — Wizard でタイトル、受入条件、ability、参考資料を確定
2. **計画** — Planner Agent が `register_task_context` + `register_plan` で SQLite に書き込み
3. **確認** — `PlanReviewAccordion` 等で Milestone / Slice / Task を逐次確認
4. **実行** — ユーザーあたり同時 1 running job。一時停止、再開、キャンセル、再試行、ブロック復旧
5. **検証** — Verifier が階層ごとにチェック。失敗 Task は個別再実行可能

データは **SSE** でジョブスナップショットを配信。Renderer 向けに **Hono** HTTP サーバーを内蔵。

## 技術スタック

| レイヤ         | 技術                                                                |
| -------------- | ------------------------------------------------------------------- |
| デスクトップ   | Electron, electron-vite                                             |
| フロント       | Vue 3, Vue Router, Tailwind CSS, vue-i18n                           |
| バックエンド   | Hono, better-sqlite3, Drizzle ORM                                   |
| Agent          | @openai/codex-sdk, Claude Agent SDK, OpenCode SDK, Cursor ACP       |
| サンドボックス | Rust native（`native/codeteam-*`、Seatbelt / bwrap / Win32 helper） |

## 設計参考と謝辞

- **GSD（Get Shit Done）** — Milestone / Slice / Task 階層、明確な完了基準、小ステップでコンテキスト腐敗を防止
- **[OpenAI Codex](https://github.com/openai/codex)** — サンドボックス分離と OS helper。native 層は `native/vendor/codex-rs` を vendor
- **[t3code](https://github.com/pingdotgg/t3code)** — デスクトップ UX 参考：プロジェクト / チャット / タスク階層、マルチ Provider、ストリーミング状態

## 実行モード

codetask は **2 つの起動モード** をサポートし、内蔵 Hono バックエンド・SQLite データ・サンドボックス supervisor を共有します。

| モード                    | 説明                                                              | デフォルト bind  |
| ------------------------- | ----------------------------------------------------------------- | ---------------- |
| **Desktop**（デフォルト） | Electron がネイティブウィンドウを開き、ローカル Web UI を読み込む | `127.0.0.1:3000` |
| **Server**（`--serve`）   | headless（ウィンドウなし）。任意のブラウザで URL にアクセス       | `0.0.0.0:8080`   |

```bash
# デスクトップモード（デフォルト）
npm run dev

# サーバーモード / headless — リモートアクセス、WSL、ヘッドレス Linux、ブラウザのみの運用向け
npm run dev:serve

# host/port を指定（開発時またはパッケージ済みアプリ）
electron . --serve --host 127.0.0.1 --port 9000

# 純粋な Node サーバー（Electron、DISPLAY、Xvfb は不要）
npm run build:server
npm run start:server -- --host 127.0.0.1 --port 8080 --data-dir ./data
```

補足:

- **Server** モードでは Electron が GPU 初期化をスキップ（WSL / CI / ヘッドレス環境向け）。
- `0.0.0.0` に bind すると、LAN 内の他端末から `http://<あなたのIP>:<ポート>` で UI にアクセス可能。
- Job 実行・Planner・サンドボックスの挙動は両モードで同一。違いはシェルのみ。
- 専用 Node エントリは常に Server モードのため、`start:server` に `--serve` は不要です。

## クイックスタート

### 要件

- Node.js 24.x
- Rust toolchain（サンドボックス native ビルド時）
- いずれか 1 つの Agent CLI をインストール・ログイン済み: Codex、Claude Code、OpenCode、Cursor CLI
- Windows / macOS / Linux（サンドボックス能力はプラットフォーム依存）

### インストール

```bash
npm install
```

### 開発

```bash
# デスクトップモード（デフォルト）— Electron ウィンドウ
npm run dev

# サーバーモード — headless、ブラウザでアクセス（上記「実行モード」参照）
npm run dev:serve
```

### ビルド

```bash
# Windows（サンドボックス含む）
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

サンドボックス native は先にビルド:

```bash
npm run build:sandbox
```

### テスト

```bash
npm run test:unit
npm run test:provider-contract
npm run test:sandbox:tdd      # native sandbox TDD（build:sandbox 必須）
npm run test:sandbox
npm run typecheck
npm run test:ci               # typecheck + 高速テストスイート
```

## アーキテクチャドキュメント

- [ADR: ホスト認可・Provider 解決・Control Plane（中国語）](./adr/0001-host-auth-and-control-plane.md)
