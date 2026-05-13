-- ============================================================================
-- 031_priority_and_member_type.sql — HD TaskBot 優先度 + 社員/委託 区分
-- ============================================================================
-- 仕様変更 (2026-05-12):
--   * tasks.priority (high/medium/low) を追加 — 緊急性の表示・ソート軸
--   * tags に type:employee (社員) / type:contractor (委託) を seed
--   * admin (田中・光さん) には type:employee を自動付与
--
-- 既存データ:
--   * priority は NOT NULL DEFAULT 'medium' で既存タスクは全て medium 扱いに
--   * type タグが未付与の friend は呼び出し側で「委託相当 (最低ルール)」と扱う
-- ============================================================================

-- (1) tasks.priority 追加 (SQLite ALTER ADD COLUMN は column-level CHECK が可)
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'
  CHECK (priority IN ('high','medium','low'));

CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

-- (2) type:employee / type:contractor タグ seed (ID は固定 UUID)
INSERT OR IGNORE INTO tags (id, name, color) VALUES
  ('c6f3a6e0-30b1-4f3e-8a9a-9d52d7c4f001', 'type:employee',   '#10B981'),
  ('c6f3a6e0-30b1-4f3e-8a9a-9d52d7c4f002', 'type:contractor', '#F59E0B');

-- (3) 既存 admin (role:admin タグ持ち) に type:employee を自動付与
--     田中・光さんは admin なので全員 社員 扱い固定
INSERT OR IGNORE INTO friend_tags (friend_id, tag_id)
SELECT f.id, 'c6f3a6e0-30b1-4f3e-8a9a-9d52d7c4f001'
FROM friends f
INNER JOIN friend_tags ft ON ft.friend_id = f.id
INNER JOIN tags t ON t.id = ft.tag_id
WHERE t.name = 'role:admin';
