-- ============================================================================
-- 030_two_phase_completion.sql — HD TaskBot 完了/問題解決の2段階承認制
-- ============================================================================
-- 仕様変更 (2026-05-08):
--   * 完了は「担当者の完了報告」+「依頼者の完了承認」の双方押下で確定
--   * 問題解決も「担当者」+「依頼者」の双方押下で確定
--   * 片側押下状態を可視化するため、各時刻を tasks に保持
--
-- 既存データ:
--   * status='done' の既存タスクには影響なし (新カラムは NULL のまま、既に completed_at あり)
--   * status='problem' / 'in_progress' / 'pending' は新仕様で運用される
-- ============================================================================

-- (1) tasks テーブルに 4 カラム追加 (SQLite は ALTER TABLE ADD COLUMN OK)
ALTER TABLE tasks ADD COLUMN completion_assignee_marked_at TEXT;
ALTER TABLE tasks ADD COLUMN completion_requester_marked_at TEXT;
ALTER TABLE tasks ADD COLUMN problem_resolved_assignee_at TEXT;
ALTER TABLE tasks ADD COLUMN problem_resolved_requester_at TEXT;

-- (2) task_events.event_type の CHECK 制約緩和 (SQLite はテーブル再作成が必要)
-- 新規追加: completion_proposed_by_assignee / by_requester / completion_finalized
--           problem_resolved_by_assignee / by_requester / problem_finalized

CREATE TABLE task_events_new (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type            TEXT NOT NULL CHECK (event_type IN (
                          'created','started','completed',
                          'delay_reported','problem_reported','postponed','cancelled',
                          'remind_pre','remind_today','overdue_alerted',
                          'request_proposed','reopened',
                          'completion_proposed_by_assignee','completion_proposed_by_requester','completion_finalized',
                          'problem_resolved_by_assignee','problem_resolved_by_requester','problem_finalized'
                        )),
  actor_friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,
  payload               TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO task_events_new (id, task_id, event_type, actor_friend_id, payload, created_at)
  SELECT id, task_id, event_type, actor_friend_id, payload, created_at FROM task_events;

DROP TABLE task_events;
ALTER TABLE task_events_new RENAME TO task_events;

-- 旧テーブルと同じ index を再作成
CREATE INDEX IF NOT EXISTS idx_task_events_task   ON task_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_actor  ON task_events(actor_friend_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_type   ON task_events(event_type, created_at DESC);
