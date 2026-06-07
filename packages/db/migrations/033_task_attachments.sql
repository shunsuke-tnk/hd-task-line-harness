-- ============================================================================
-- 033_task_attachments.sql — HD TaskBot: 依頼フォームのファイル添付
-- ============================================================================
-- タスク依頼フォームでアップロードされたファイルを R2 (IMAGES バケット) に保存し、
-- そのメタデータをタスクに紐づける。実体は R2、ここではキーと表示名のみ保持する。
--   * r2_key       : R2 オブジェクトキー (例: att-<uuid>.pdf)。配信は /files/:key
--   * file_name    : ユーザーがアップロードした元のファイル名 (表示用)
--   * ON DELETE CASCADE: タスク削除時に添付メタも削除 (R2 実体の掃除は別途)
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_attachments (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  r2_key                TEXT NOT NULL,
  file_name             TEXT NOT NULL,
  mime_type             TEXT,
  size                  INTEGER,
  uploaded_by_friend_id TEXT REFERENCES friends(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id, created_at);
