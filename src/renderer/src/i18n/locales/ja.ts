import { turnErrorsJa } from '@shared/turn-errors/i18n-ja'

export default {
  common: {
    username: 'ユーザー名',
    password: 'パスワード',
    usernamePlaceholder: 'ユーザー名を入力',
    passwordPlaceholder: 'パスワードを入力',
    unknown: '不明',
    admin: '管理者',
    operationFailed: '操作に失敗しました',
    cancel: 'キャンセル',
    preview: 'プレビュー',
    delete: '削除',
    loading: '読み込み中',
    captchaLabel: '認証コード',
    captchaPlaceholder: 'コードを入力',
    captchaLoadFailed: '認証コードの読み込みに失敗しました',
    captchaLoading: '認証コード読み込み中…',
    showPassword: 'パスワードを表示',
    hidePassword: 'パスワードを非表示'
  },
  login: {
    title: 'ログイン',
    description: '管理者アカウントでログイン',
    submit: 'ログイン',
    submitting: 'ログイン中…',
    captchaRequired: '認証コードを入力してください',
    accountLocked: 'アカウントは一時的にロックされています'
  },
  setup: {
    title: '初期設定',
    description: '初回利用時は管理者アカウントを作成してください',
    combinedDescription: 'データディレクトリの選択と管理者アカウントの作成を一度に完了します',
    submit: '初期設定を完了',
    submitting: '送信中…',
    setupTokenLabel: 'セットアップトークン（サーバーコンソールから）',
    setupTokenPlaceholder: 'サーバーコンソールに表示されたセットアップトークンを入力',
    credentialsHint:
      'ユーザー名は 4〜32 文字、英字で始まり、英数字・アンダースコア・ハイフンのみ。admin/root などの予約名は不可。パスワードは 8 文字以上で、大文字・小文字・数字・記号を含めてください。',
    confirmPassword: 'パスワード確認',
    confirmPasswordPlaceholder: 'もう一度パスワードを入力',
    passwordMismatch: 'パスワードが一致しません',
    storageTitle: 'データ保存先を選択',
    storageDescription:
      'CodeTask のデータベース、添付ファイル、分離された Provider ランタイムの保存先を選択します。デフォルトフォルダが無い場合は自動作成します。',
    storagePathLabel: 'データディレクトリ',
    storagePathRequired: 'データディレクトリを入力してください',
    storageBrowse: '参照',
    storageBrowseTitle: 'データディレクトリを選択',
    storageBrowseHint: 'ローカルフォルダを参照するか、新しいサブフォルダを作成して選択できます。',
    storageSelectDirectory: 'このディレクトリを使用',
    storageCreateFolder: '作成して選択',
    storageValidate: 'ディレクトリを検証',
    storageValidating: '検証中…',
    storageConfirm: '確認して初期化',
    storageInitializing: '初期化中…',
    storageValidatedPath: '検証済みパス：{path}',
    storageRestarting: 'ストレージを初期化しました',
    storageRecoveryTitle: 'ストレージの復旧が必要です',
    storageRecoveryDescription:
      '保存先が破損しているか見つかりません。既存の CodeTask データディレクトリを復旧するか、空のフォルダを選んで再初期化できます。',
    storageRecover: 'このディレクトリを使用',
    storageRecovering: '復旧中…',
    storageRecovered: '保存先を復旧しました',
    errors: {
      pathNotAbsolute: '絶対パスを入力してください',
      pathNotWritable: '書き込みできません。別の場所を選んでください',
      pathNotEmpty:
        '空でないディレクトリで、CodeTask データルートでもありません。空のフォルダを選んでください',
      pathForbiddenRoot: 'システムルートやホームディレクトリは使用できません',
      pathOwnedByOther: 'このディレクトリは別の CodeTask インストールに属しています',
      markerMissing:
        '有効な CodeTask データマーカーがありません。初回は空フォルダを、復旧時は元のデータディレクトリを選んでください',
      databaseMissing: 'このディレクトリにデータベースがありません',
      locatorUnreadable: '保存された保存先設定が壊れています。再度選択してください',
      locatorInvalid: '保存された保存先設定が無効です。再度選択してください',
      legacyLocatorConflict:
        '異なる保存先設定が複数見つかりました。使用する元のデータディレクトリを選択してください',
      legacyLocatorMigrationFailed:
        '元の保存先設定を移行できませんでした。元のデータディレクトリを再度選択してください',
      installationMismatch: 'データディレクトリがこのインストールと一致しません',
      validationExpired: 'ディレクトリ検証の期限が切れました。再試行してください',
      insufficientSpace: 'ディスク容量が不足しています'
    }
  },
  bootstrap: {
    connectionError: 'サービスに接続できません：{error}',
    bootstrapFailed: 'サービスへの接続に失敗しました'
  },
  errors: {
    emptyCredentials: 'ユーザー名とパスワードを入力してください',
    alreadyInitialized: 'システムは既に初期化されています',
    setupRequired: '先に初期設定を完了してください',
    invalidCredentials: 'ユーザー名またはパスワードが正しくありません',
    requestFailed: 'リクエストに失敗しました',
    unauthorized: 'ログインしていません',
    sessionExpired: 'セッションの有効期限が切れました',
    projectNotFound: 'プロジェクトが見つかりません',
    threadNotFound: 'スレッドが見つかりません'
  },
  language: {
    label: '言語',
    zh: '中文',
    ja: '日本語',
    en: 'English'
  },
  folderPicker: {
    close: '閉じる',
    pathPlaceholder: 'パスを入力（例: ~ または E:\\projects）',
    select: '選択',
    newFolderPlaceholder: '新規フォルダ名',
    createAndAdd: '作成して追加',
    currentDirectory: '現在のディレクトリ：{path}',
    selectCurrent: '現在のディレクトリを選択',
    adding: '追加中…',
    selectRequired: 'ディレクトリを選択してください',
    folderNameRequired: '作成するフォルダ名を入力してください',
    browseFailed: 'ディレクトリの参照に失敗しました',
    parentFailed: '親ディレクトリを開けませんでした',
    addFailed: 'プロジェクトの追加に失敗しました',
    goParent: '親ディレクトリ'
  },
  workspace: {
    section: {
      workspace: 'ワークスペース',
      projects: 'プロジェクト'
    },
    nav: {
      chat: 'チャット',
      tasks: 'タスク',
      settings: '設定',
      createTask: 'タスク作成'
    },
    addProject: 'ローカルフォルダを追加',
    addProjectHint: 'ローカルフォルダを追加…',
    loading: '読み込み中…',
    noThreads: 'スレッドがありません',
    expand: '展開',
    collapse: '折りたたむ',
    layout: {
      expandPanel: '{label}を展開',
      collapsePanel: '{label}を折りたたむ'
    },
    newThread: '新しいスレッド',
    newThreadInProject: '{project} に新しいスレッドを作成',
    selectProject: '左のプロジェクトを選択するか、ローカルフォルダを追加してください',
    noThreadHint: 'スレッドがありません。「新しいスレッド」をクリックして計画を始めましょう',
    switchingCore: 'CLI を切り替え中…',
    running: '実行中…',
    lastRunFailed: '前回の実行に失敗しました',
    coreUnavailable: '現在の CLI は利用できません。インストールして再試行してください。',
    loadingMessages: 'メッセージを読み込み中…',
    loadThreadFailed: 'スレッドの読み込みに失敗しました',
    switchCoreFailed: 'CLI の切り替えに失敗しました',
    sendFailed: '送信に失敗しました',
    relativeHours: '{n} 時間前',
    relativeMinutes: '{n} 分前',
    composer: {
      placeholder: 'フォローアップの変更を入力…',
      attachment: '添付',
      addAttachment: '添付を追加（画像またはファイル）',
      codeChanges: 'コード変更',
      codeChangesHint: '実行中タスクの作業領域には書き込まず、隔離 Change Set で編集します',
      send: '送信',
      thinking: '思考中',
      thinkingStreaming: '思考中…',
      thinkingDone: '思考済み',
      thinkingDoneWithDuration: '思考済み（{duration}）',
      thinkingDurationSeconds: '{n} 秒'
    },
    changeSet: {
      label: '隔離コード変更',
      apply: 'プロジェクトに適用',
      ready: 'パッチを生成',
      rebase: '最新状態にリベース',
      cancel: '破棄',
      status: {
        queued: '待機中',
        preparing_worktree: '作業ツリーを準備中',
        editing: '編集中',
        validating: '検証中',
        ready_to_apply: '適用可能',
        applying: '適用中',
        applied: '適用済み',
        needs_resolution: '競合の解決が必要',
        failed: '失敗',
        cancelled: '破棄済み'
      }
    },
    core: {
      claude: 'Claude',
      claudeCode: 'Claude Code',
      codex: 'Codex'
    },
    demo: {
      userMessage:
        'Vue 3 + Vite のシンプルなブログプロジェクトを作ってください。バックエンド API は不要で、ローカルの Markdown ファイルをデータソースにしてください。',
      assistantMessage:
        '## スコープ\n\n- Vue 3 + Vite プロジェクトの骨組みを作成\n- Markdown 記事の一覧・詳細ページを実装\n- ローカルファイルをデータソースに使用（バックエンド API 不要）\n\n## アーキテクチャ\n\n- ルート：トップ一覧 + 記事詳細\n- データ：ビルド時または実行時に `content/` ディレクトリの Markdown を読み込み\n\n## エラー処理\n\n- ファイルが見つからない場合はわかりやすいメッセージを表示\n- 未知のルートでは 404 ページを表示\n\n## 品質基準\n\n- TypeScript 厳格モード\n- コンポーネント分割が明確で、スタイルが読みやすいこと'
    },
    tasks: {
      title: 'タスク一覧',
      total: '現在 {count} 件の大タスク',
      empty: 'このフィルターにタスクはありません',
      selectHint: '左のタスクを選ぶと実行ツリーとパラメータを表示します',
      backToList: 'タスク一覧に戻る',
      loadFailed: 'タスク一覧の読み込みに失敗しました',
      detailFailed: 'タスク詳細の読み込みに失敗しました',
      executionTree: '実行ツリー',
      taskParameters: 'タスクパラメータ',
      runHistory: '実行履歴',
      cliLabel: 'CLI: {summary}',
      filters: {
        all: 'すべて',
        pending: 'キュー中',
        planning: '計画中',
        planReady: '計画完了',
        planConfirmed: '確認済み',
        running: '実行中',
        pausing: '一時停止中',
        paused: '一時停止',
        completed: '完了',
        failed: '失敗',
        cancelled: 'キャンセル'
      },
      actions: {
        pause: '一時停止',
        resume: '再開',
        continue: '続行',
        restart: '進捗を消去して最初から実行',
        cancel: 'キャンセル',
        delete: '削除'
      },
      actionFailed: 'タスク操作に失敗しました',
      recovery: {
        retry: '続行すると、完了済みタスクを保持したまま失敗地点から再試行します。',
        remediate: '続行すると、補修タスクを先に実行してから失敗地点に戻ります。',
        resume: '続行すると、完了済みタスクを保持したまま最新の中断地点から再開します。',
        needs_attention: '外部依存または手動条件を解決してから、中断地点より続行してください。'
      },
      progress: {
        label: '完了率',
        planLabel: '計画生成',
        executionLabel: 'タスク実行',
        waiting: '開始待ち',
        planningFailed: '計画生成に失敗しました',
        needsAuth: 'CLI が未ログインです。端末で先にログインしてください',
        cleanupFailed: 'サンドボックスが異常終了しました。アプリを再起動して再試行してください',
        planReady: '計画が生成されました',
        planStepsDone: '計画 {done}/{total} ステップ',
        stepsDone: '完了 {done}/{total} サブタスク',
        planning: '計画生成中 {done}/{total}',
        planningPartial: '計画生成中 · {done} ステップ完了',
        planningRunning: '計画を生成中…',
        planOutlineReady: '計画の骨格をロックしました（{total} タスク）。詳細を生成中…',
        planFinalizing: '計画構造は準備完了、仕上げ中…',
        executionDone: '実行完了 {done}/{total}',
        executionFailed: '実行失敗',
        executionPaused: '一時停止 · {done}/{total}',
        executionRunning: '実行中 {done}/{total}',
        executionStarting: '実行を開始中…',
        code: {
          'plan.pending':
            'キューに入っています。前のタスクが完了または一時停止するのを待っています…',
          'plan.planning': '計画を生成中…',
          'plan.outline_ready': '計画の骨格をロックしました（{total} タスク）。詳細を生成中…',
          'plan.planning_partial': '計画生成中 · {done} ステップ完了',
          'plan.planning_failed': '計画生成に失敗しました',
          'plan.needs_auth': 'CLI が未ログインです。端末で先にログインしてください',
          'plan.cleanup_failed':
            'サンドボックスが異常終了しました。アプリを再起動して再試行してください',
          'plan.plan_ready': '計画が生成されました',
          'plan.draft_unlocked': '草案のロックを解除しました。実行ツリーをクリアしました',
          'plan.tree_not_ready': '実行ツリーはまだ準備できていません',
          'plan.regenerating': '実行計画を再生成中…',
          'execution.pending':
            'キューに入っています。前のタスクが完了または一時停止するのを待っています…',
          'execution.starting': '実行を開始中…',
          'execution.resuming': '実行を再開中…',
          'execution.stale_running':
            'アプリ再起動後に実行が一時停止されました。続行するには再開をクリックしてください',
          'execution.completed': '実行が完了しました',
          'execution.failed': '実行に失敗しました',
          'execution.running_task': '{id} を実行中',
          'execution.verifying_slice': 'スライス {id} を検証中',
          'execution.verifying_milestone': 'マイルストーン {id} を検証中',
          'execution.slice_accepted': 'スライス {id} が承認されました',
          'execution.milestone_accepted': 'マイルストーン {id} が承認されました',
          'execution.slice_blocked': 'スライス {id} の検証がブロックされています',
          'execution.milestone_blocked': 'マイルストーン {id} の検証がブロックされています',
          'execution.slice_inconclusive_exhausted':
            'スライス {id} の検証が {maxAttempts} 回目で未確定のままです',
          'execution.milestone_inconclusive_exhausted':
            'マイルストーン {id} の検証が {maxAttempts} 回目で未確定のままです',
          'execution.evidence_incomplete': 'タスク証跡チェーンが不完全です',
          'execution.evidence_missing': '構造化証跡パッケージがありません',
          'execution.recovery_infra_retry': '{id} を再試行中',
          'execution.recovery_prep_injected': '証跡補充タスクを注入しました',
          'execution.recovery_repair_injected': '修復タスクを注入しました',
          'execution.continuing_task': '{id} から続行中',
          'execution.workflow_deadlock':
            '実行可能なサブタスクがありません。ワークフローがブロックされています',
          'execution.workflow_failed_block':
            '失敗したサブタスクがあります。ワークフローがブロックされています'
        }
      },
      status: {
        pending: 'キュー中',
        planning: '計画中',
        plan_editing: 'レビュー中',
        plan_confirmed: '確認済み',
        plan_ready: '計画完了',
        running: '実行中',
        pausing: '一時停止中',
        paused: '一時停止',
        completed: '完了',
        failed: '失敗',
        cancelled: 'キャンセル'
      },
      queue: {
        next: '待機中（次に実行）',
        position: '待機中（{position} 番目）'
      },
      tree: {
        empty: '計画データがありません',
        planned: '計画済み',
        queued: '実行待ち',
        pending: '計画待ち',
        cli: 'CLI: {name}',
        milestoneFallback: 'マイルストーン {n}',
        sliceFallback: 'スライス {n}',
        exec: {
          completed: '完了',
          in_progress: '実行中',
          paused: '一時停止',
          failed: '失敗',
          pending: '待機',
          queued: 'キュー',
          skipped: 'スキップ',
          'retry-queued': '再試行待ち',
          'waiting-on-dependency': '前置待ち',
          blocked: 'ブロック'
        },
        statusIconHint: 'タスク状態（○ 待機 · ◉ 実行中 · ✓ 完了）',
        referenceCount: '参考 ×{count}'
      },
      planNode: {
        clickHint:
          'マイルストーン・スライス・タスク行をクリックすると、下に詳細と検証情報が表示されます',
        accordionHint:
          '左の矢印でマイルストーン・スライス・タスクを展開し、詳細の確認や CLI の変更ができます',
        detailTitle: 'ノード詳細',
        selectHint: '実行ツリーのマイルストーン・スライス・タスクをクリックしてください',
        milestone: 'マイルストーン',
        slice: 'スライス',
        successCriteria: '成功基準',
        acceptanceSignals: '受け入れシグナル',
        noAcceptanceSignals: '受け入れシグナルなし',
        expectedArtifacts: '期待成果物',
        noExpectedArtifacts: '期待成果物なし',
        verificationStatus: '検証状態',
        runtimeStatus: '実行状態',
        taskCliHint: 'このサブタスク専用の実行 CLI を指定'
      },
      parameters: {
        selectHint: '実行ツリーのタスクをクリックしてパラメータを表示',
        title: 'タスクタイトル',
        kind: 'タスク種別',
        abilityCli: '能力 / CLI',
        description: '説明',
        noDescription: '説明なし',
        context: '実行コンテキスト',
        contextPlaceholder: 'Planner 生成後に完全なコンテキストがここに表示されます。',
        references: '参考資料',
        referenceReason: '割当説明：{reason}',
        noReferenceDescription: '参考説明なし',
        referencesEditHint: 'このタスクで使う参考資料にチェックを入れ、用途を説明してください。',
        referenceReasonLabel: '割当説明',
        referenceReasonPlaceholder: 'これらの参考資料をこのタスクでどう使うか…',
        referenceRequired: '必須',
        saveReferences: '参考資料を保存',
        executionOutcome: '実行結果',
        recoveryKind: '分類',
        recoveryAction: '復旧アクション',
        recoveryAttempt: '試行回数',
        evidenceDetail: '証跡詳細',
        evidenceLoading: '完全な証跡を読み込み中…',
        evidenceLoadFailed: '証跡詳細を読み込めませんでした',
        evidenceUnavailable: '証跡詳細は利用できません（期限切れまたは未提出）',
        evidenceExpand: 'すべて表示',
        evidenceCollapse: '折りたたむ'
      },
      history: {
        empty: '実行履歴はまだありません'
      }
    },
    draftPanel: {
      title: 'ドラフトと実行ツリー',
      empty: 'ドラフトがありません。左のチャットで要件を説明すると自動生成されます',
      untitled: '無題のドラフト',
      statusEditing: '編集中',
      statusConfirmed: '確認済み',
      statusArchived: 'アーカイブ',
      executionTree: '実行ツリー',
      editArea: '編集エリア',
      editDraft: 'ドラフトを編集',
      centerEmpty: '左のチャットで要件を説明するか、草案の生成を待ってください',
      planNotReady: '実行ツリーはまだありません。草案ステップで確認して生成してください',
      confirmPlan: '実行ツリーを確認してキューに追加',
      launchPlan: '起動してキューに追加',
      launchRequiresDesignSession:
        'DesignSession（ds-*）から Launch してください。旧 job 確認は無効です',
      confirmDraft: 'ドラフトを確認して実行ツリーを生成',
      confirmedHint: 'ドラフトを確認しました。下で実行ツリーを確認してください',
      referenceManifestStaleHint:
        '参考資料が前回の凍結以降に変更されています。起動前に再凍結してください。',
      refreezeCorpus: '参考資料を再凍結',
      refreezingCorpus: '凍結中…',
      refreezeSuccess: '参考資料を再凍結しました。起動してキューに追加できます。',
      corpusPlanEditHint: '計画段階で参考資料を変更した場合は、起動前に再凍結が必要です。',
      corpusLoading: '参考資料を読み込み中…'
    },
    create: {
      selectProjectTitle: 'プロジェクトフォルダを選択',
      selectProjectHint:
        '既存のプロジェクトを選ぶか、ローカルフォルダを追加してタスク作成を開始します。',
      projectDialogTitle: '新規タスク',
      projectDialogHint: '作業ディレクトリを選んで新しいタスク草案を開始します。',
      tabBrowseDirectory: '作業ディレクトリを選択',
      tabRecentDirectories: '最近の作業ディレクトリ',
      recentDirectoriesEmpty:
        '最近のプロジェクトがありません。まず「作業ディレクトリを選択」でフォルダを追加してください。',
      existingProjects: '既存プロジェクト',
      addFolder: 'ローカルフォルダを追加',
      newDraftThread: '新しいタスク会話',
      draftListTitle: '草案リスト',
      draftListHint:
        '未完了の草案はここに保存されます。クリックして続行できます。新規作成は「新規タスク」を押してください。',
      startNew: '新規タスク',
      backToDraftList: '草案リストに戻る',
      draftListEmpty: '未完了の草案はありません',
      draftIncompleteEmpty: '進行中の草案はありません',
      draftStatusLaunched: '完了',
      draftStatusInProgress: '進行中',
      draftStatusPlanningFailed: '計画失敗',
      planningFailedTitle: '実行ツリーの生成が中断されました',
      retryPlanning: '計画生成を再試行',
      retryingPlanning: '再試行中…',
      step0Hint:
        '左のチャットでタスクの要件・範囲・制約を説明してください。情報が十分に集まると MCP で草案が生成され、ステップ 2 に進みます。',
      prevStep: '前へ',
      nextStep: '次へ',
      stepProgress: 'ステップ {current}/{total}',
      queuedSuccess: '実行ツリーを確認しました。タスクをキューに追加しました。',
      steps: {
        collect: '要件収集',
        draft: '草案確認',
        executionTree: '実行ツリー'
      }
    },
    draft: {
      badge: 'タスク起動ドラフト',
      statusLaunched: '送信済み',
      statusPending: '保留中',
      requirementsContract: '要件契約',
      confirmed: '確認済み',
      pendingConfirm: '未確認',
      confirmedAt: '{time} に確認',
      confirming: '確認中…',
      confirmContract: '要件契約を確認',
      unlockContract: '契約のロック解除',
      unlockingContract: '解除中…',
      unlockContractFailed: '契約のロック解除に失敗しました',
      markdownEdit: '編集',
      markdownPreview: 'プレビュー',
      markdownEmpty: '内容なし',
      saving: '保存中…',
      contractSaveFailed: '要件契約の保存に失敗しました',
      abilitiesCli: '能力 / CLI',
      selectCli: 'CLI を選択',
      cliUnavailable: '利用不可',
      references: '参考資料',
      referencesHint:
        '画像と非テキストファイルには計画参考説明が必須です。Planner が関連タスクに割り当て、実行時の参照に使います。',
      referenceDescriptionLabel: '計画参考説明',
      referenceDescriptionPlaceholder:
        'どのページ/機能か、レイアウト・文言・インタラクションの要点…',
      referenceDescriptionRequired:
        '計画生成前に、画像・ファイル添付すべてに参考説明を入力してください。',
      referenceUploadDialogTitle: '参考資料の説明を入力',
      referenceUploadDialogHint:
        'この添付を参考資料に追加します。Planner と実行タスクでの使い方を説明してください。',
      referenceSaveFailed: '参考説明の保存に失敗しました',
      uploadReferences: '参考資料をアップロード',
      uploadingReferences: 'アップロード中…',
      importFromChat: '会話からインポート',
      noReferences:
        '参考資料がありません。画像やファイルをアップロードするか、会話の添付からインポートしてください。',
      importDialogTitle: '会話から添付をインポート',
      importDialogEmpty: 'この会話にインポート可能な添付はありません',
      importing: 'インポート中…',
      importSelected: '選択をインポート',
      launchedHint: '計画を送信しました。サイドバーの「タスク」で進捗を確認してください。',
      readyHint: '要件契約が確認されました。各能力の CLI を選択してから計画を生成してください。',
      pendingHint: '要件契約を確認し、各能力の CLI を選択してから計画を生成してください。',
      generatePlan: '計画を生成',
      submitting: '送信中…',
      uploadFailed: 'アップロードに失敗しました',
      deleteFailed: '削除に失敗しました',
      importFailed: 'インポートに失敗しました',
      confirmFailed: '確認に失敗しました',
      launchFailed: '開始に失敗しました'
    },
    settings: {
      title: '設定',
      sidebar: 'SETTINGS',
      loading: '設定を読み込み中…',
      saving: '保存中…',
      save: '保存',
      loadFailed: '設定の読み込みに失敗しました',
      saveFailed: '設定の保存に失敗しました',
      saveSuccess: '設定を保存しました',
      sections: {
        language: '言語',
        storage: 'データストレージ',
        sandbox: 'サンドボックス',
        controlPlane: 'Control Plane',
        mcp: 'MCP',
        prompts: 'Prompts'
      },
      sandbox: {
        title: 'サンドボックス',
        description: '外側サンドボックスの健全性とランタイム依存関係のチェック。',
        loading: 'サンドボックス状態を読み込み中…',
        native: 'Native モジュール',
        platformRuntime: 'プラットフォームランタイム',
        supervisor: 'Supervisor',
        windowsSetup: 'Windows セットアップ',
        checkOk: '正常',
        unknown: '不明',
        status: {
          ready: '準備完了',
          degraded: '低下',
          unavailable: '利用不可',
          disabled: '無効'
        }
      },
      storage: {
        title: 'データストレージ',
        description:
          '使用量を確認し、検証・移行・再起動を通じてデータルート全体を安全に移動します。',
        loading: 'ストレージ情報を読み込み中…',
        loadFailed: 'ストレージ情報の読み込みに失敗しました',
        currentPath: '現在のデータルート',
        source: 'ソース：{source}',
        total: '合計',
        reclaimable: 'DB 回収可能',
        changeTitle: 'データルートを移動',
        browse: '参照',
        browseTitle: '新しいデータディレクトリを選択',
        browseHint: 'ローカルフォルダを参照するか、新しいサブフォルダを作成して選択できます。',
        selectDirectory: 'このディレクトリを使用',
        createFolder: '作成して選択',
        migrate: '検証して移行',
        managed: 'このパスは CLI または環境設定で管理されているため、ここでは変更できません。',
        phase: '移行フェーズ：{phase}',
        restart: '新しいデータルートで再起動',
        deleteOld: '古いデータルートを削除',
        migrationFailed: 'ストレージ移行に失敗しました',
        deleteOldFailed: '古いストレージの削除に失敗しました'
      },
      languageSection: {
        title: '言語',
        description: 'アプリの表示言語を選択します。'
      },
      controlPlane: {
        title: 'Control Plane Cores',
        description:
          'Planner と検証ロールのデフォルト CLI を指定します。会話スレッドの CLI とは独立です。',
        planner: 'Planner',
        sliceVerifier: 'Slice Verifier',
        milestoneVerifier: 'Milestone Verifier',
        unavailable: '利用不可'
      },
      prompts: {
        title: 'プロンプトポリシー',
        description:
          '会話、Planner、Slice Verifier、Milestone Verifier のシステムプロンプトを設定します。',
        conversation: '会話（Main Agent）',
        planner: 'Planner',
        sliceVerifier: 'Slice Verifier',
        milestoneVerifier: 'Milestone Verifier',
        useDefault: 'デフォルトプロンプトを使用',
        systemPrompt: 'System Prompt',
        resetDefault: 'デフォルトに戻す'
      },
      mcp: {
        title: '補足 MCP',
        description:
          'ロールと CLI ごとにユーザー拡張 MCP を設定します。システム制御 MCP は実行時にセッション単位で注入・マージされます。',
        mergeHint:
          'ここではユーザー拡張 MCP のみ編集できます。制御ロール MCP は実行時に注入され、双方を公開せずにマージされます。',
        roles: {
          conversation: '会話',
          task: 'タスク実行',
          verification: '検証（Planner / Verifier）'
        },
        rootKey: 'ルートキー：{key}',
        resetCli: 'クリア',
        invalidJson: 'JSON が無効です',
        constraintsTitle: 'Managed Constraints',
        reservedNames: 'RESERVED SERVER NAMES',
        rootKeys: 'ROOT KEYS'
      }
    }
  },
  turnErrors: turnErrorsJa
} as const
