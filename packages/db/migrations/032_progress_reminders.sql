-- ============================================================================
-- 032_progress_reminders.sql — HD TaskBot 段階リマインド + 社員日報 用 event_type 拡張
-- ============================================================================
-- 仕様変更 (2026-05-12):
--   * task_events.event_type の CHECK 制約に 6 種を追加
--     progress_reminder_first  — 中間日 / 1/3 地点の進捗報告要求 push
--     progress_reminder_second — 2/3 地点の進捗報告要求 push (D>=9 のみ)
--     progress_reported        — 担当者が進捗カードを送信したログ
--     daily_report_requested   — 社員向け朝の日報リマインド送信ログ
--     daily_report_submitted   — 社員が日報を返したログ
--     member_type_changed      — 社員/委託 区分の変更履歴 (admin 監査用)
--
-- SQLite は ALTER TABLE で CHECK 制約を変更できないため、テーブル再作成を行う。
-- migration 030 と同じパターン (lessons #11)。
-- ============================================================================

CREATE TABLE task_events_new (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type            TEXT NOT NULL CHECK (event_type IN (
                          'created','started','completed',
                          'delay_reported','problem_reported','postponed','cancelled',
                          'remind_pre','remind_today','overdue_alerted',
                          'request_proposed','reopened',
                          'completion_proposed_by_assignee','completion_proposed_by_requester','completion_finalized',
                          'problem_resolved_by_assignee','problem_resolved_by_requester','problem_finalized',
                          'progress_reminder_first','progress_reminder_second','progress_reported',
                          'daily_report_requested','daily_report_submitted','member_type_changed'
                        )),
  actor_friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,
  payload               TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO task_events_new (id, task_id, event_type, actor_friend_id, payload, created_at)
  SELECT id, task_id, event_type, actor_friend_id, payload, created_at FROM task_events;

DROP TABLE task_events;
ALTER TABLE task_events_new RENAME TO task_events;

CREATE INDEX IF NOT EXISTS idx_task_events_task   ON task_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_actor  ON task_events(actor_friend_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_type   ON task_events(event_type, created_at DESC);
