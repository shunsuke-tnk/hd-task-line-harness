// =============================================================================
// HD TaskBot — Task attachments (R2)
// =============================================================================
// 依頼フォームから添付されたファイルを R2 (IMAGES バケット) に保存し、
// task_attachments テーブルでタスクに紐づける。配信は公開ルート /files/:key。
// migration 033_task_attachments.sql でテーブルを追加。
// =============================================================================

export interface TaskAttachmentRow {
  id: string;
  task_id: string;
  r2_key: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
}

export interface TaskAttachmentInput {
  taskId: string;
  r2Key: string;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  uploadedByFriendId: string | null;
}

/** R2 キーから公開配信URL (絶対URL) を組み立てる。 */
export function attachmentUrl(workerUrl: string, key: string): string {
  const base = (workerUrl || '').replace(/\/+$/, '');
  return `${base}/files/${encodeURIComponent(key)}`;
}

export async function insertTaskAttachment(
  db: D1Database,
  input: TaskAttachmentInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO task_attachments
         (id, task_id, r2_key, file_name, mime_type, size, uploaded_by_friend_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(
      crypto.randomUUID(),
      input.taskId,
      input.r2Key,
      input.fileName.slice(0, 255),
      input.mimeType,
      input.size,
      input.uploadedByFriendId,
    )
    .run();
}

export async function listTaskAttachments(
  db: D1Database,
  taskId: string,
): Promise<TaskAttachmentRow[]> {
  const result = await db
    .prepare(
      `SELECT id, task_id, r2_key, file_name, mime_type, size, created_at
       FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .bind(taskId)
    .all<TaskAttachmentRow>();
  return result.results ?? [];
}

/** Flex カード用の {fileName, url} 配列に変換。 */
export async function listTaskAttachmentViews(
  db: D1Database,
  taskId: string,
  workerUrl: string,
): Promise<Array<{ fileName: string; url: string }>> {
  const rows = await listTaskAttachments(db, taskId);
  return rows.map((r) => ({ fileName: r.file_name, url: attachmentUrl(workerUrl, r.r2_key) }));
}
