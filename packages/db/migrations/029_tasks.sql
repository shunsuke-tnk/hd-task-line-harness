-- ============================================================================
-- 029_tasks.sql — HD TaskBot extension (tasks / task_events / staff_metrics)
-- ============================================================================
-- HD TaskBot は LINE Harness の標準機能 (friends/tags/rich-menu/automation/forms)
-- に加えて、独自の「タスク管理」テーブルを必要とする。
--
-- 設計指針:
--   * tasks: 1依頼 = 1行。担当者(assignee_friend_id) と依頼者(requester_friend_id) を friends に紐付け
--   * task_events: 監査ログ (created/started/completed/delay_reported/postponed/...) を時系列で蓄積
--   * staff_metrics: 申告漏れ/申告できた/遅延申請の3カウンタを friend ごとに集計
--   * display_id (#MMDD-N) は人間用、id (T-YYYYMMDD-HHMMSS) は内部キー
-- ============================================================================

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,                     -- T-YYYYMMDD-HHMMSS (UTC+9)
  display_id            TEXT NOT NULL,                        -- #MMDD-N (UI用、削除番号は再利用しない)
  title                 TEXT NOT NULL,                        -- タスク内容 (80字以内推奨)
  description           TEXT,                                 -- 詳細メモ (任意)
  requester_friend_id   TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  assignee_friend_id    TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  due_at                TEXT NOT NULL,                        -- ISO 8601 +09:00
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','in_progress','done','delayed','problem','cancelled')),
  started_at            TEXT,                                 -- 着手記録 (任意)
  completed_at          TEXT,
  postpone_count        INTEGER NOT NULL DEFAULT 0,           -- 遅延報告回数
  problem_count         INTEGER NOT NULL DEFAULT 0,           -- 問題報告回数
  overdue_alerted       INTEGER NOT NULL DEFAULT 0,           -- 期日超過アラート済フラグ (0/1)
  line_account_id       TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, -- マルチアカウント
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_friend_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_requester      ON tasks(requester_friend_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due            ON tasks(due_at, status);
CREATE INDEX IF NOT EXISTS idx_tasks_display_id     ON tasks(display_id);
CREATE INDEX IF NOT EXISTS idx_tasks_account        ON tasks(line_account_id);

-- ----------------------------------------------------------------------------
-- task_events — 監査ログ (削除しない)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_events (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type            TEXT NOT NULL CHECK (event_type IN (
                          'created','started','completed',
                          'delay_reported','problem_reported','postponed','cancelled',
                          'remind_pre','remind_today','overdue_alerted',
                          'request_proposed','reopened'
                        )),
  actor_friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,
  payload               TEXT NOT NULL DEFAULT '{}',           -- JSON: 詳細 (delay_days, problem_text, ...)
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_events_task   ON task_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_actor  ON task_events(actor_friend_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_type   ON task_events(event_type, created_at DESC);

-- ----------------------------------------------------------------------------
-- staff_metrics — メンバーごとのカウンタ
-- ----------------------------------------------------------------------------
-- no_report_count          : 期日超過後、本人の遅延/完了報告がない状態で
--                            botの超過アラートが発火した回数 (申告漏れ)
-- reported_on_time_count   : 期日内に完了 or 遅延報告ボタンを押せた回数
--                            (= 「日々の報告ができている」健全度指標)
-- delay_report_count       : 遅延報告ボタンを押した累積数
--                            (本要件: 遅延があっても申告があれば問題ない)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_metrics (
  friend_id             TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  no_report_count       INTEGER NOT NULL DEFAULT 0,
  reported_on_time_count INTEGER NOT NULL DEFAULT 0,
  delay_report_count    INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
