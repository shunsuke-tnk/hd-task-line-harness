import { jstNow, toJstString } from './utils.js';

// =============================================================================
// HD TaskBot — Tasks / Task Events / Staff Metrics
// =============================================================================
// LINE Harness の標準テーブルに加えて、HD TaskBot 用の独自スキーマ。
// migration: 029_tasks.sql
// =============================================================================

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'delayed'
  | 'problem'
  | 'cancelled';

export type TaskEventType =
  | 'created'
  | 'started'
  | 'completed'
  | 'delay_reported'
  | 'problem_reported'
  | 'postponed'
  | 'cancelled'
  | 'remind_pre'
  | 'remind_today'
  | 'overdue_alerted'
  | 'request_proposed'
  | 'reopened';

export interface Task {
  id: string;
  display_id: string;
  title: string;
  description: string | null;
  requester_friend_id: string;
  assignee_friend_id: string;
  due_at: string;
  status: TaskStatus;
  started_at: string | null;
  completed_at: string | null;
  postpone_count: number;
  problem_count: number;
  overdue_alerted: number;
  line_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  event_type: TaskEventType;
  actor_friend_id: string | null;
  payload: string; // JSON
  created_at: string;
}

export interface StaffMetrics {
  friend_id: string;
  no_report_count: number;
  reported_on_time_count: number;
  delay_report_count: number;
  updated_at: string;
}

// ── ID 生成 ──────────────────────────────────────────────────────────────────

/**
 * Generate internal task id: T-YYYYMMDD-HHMMSS (UTC+9 ベース).
 * 同秒内の衝突は呼び出し側で再採番せず、display_id 採番でユニーク性を担保。
 */
export function generateTaskId(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60_000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mi = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');
  return `T-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * Compute display_id (#MMDD-N) atomically.
 * 同日 (JST) の created_at をカウントし、N = count + 1。
 * 削除/キャンセルされた番号も含めて MAX(seq)+1 で進めるため、再利用しない。
 */
export async function nextDisplayId(db: D1Database, now: Date = new Date()): Promise<string> {
  const jst = new Date(now.getTime() + 9 * 60 * 60_000);
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const prefix = `#${mm}${dd}-`;
  const row = await db
    .prepare(
      `SELECT display_id FROM tasks
       WHERE display_id LIKE ?
       ORDER BY display_id DESC LIMIT 1`,
    )
    .bind(`${prefix}%`)
    .first<{ display_id: string }>();
  let next = 1;
  if (row?.display_id) {
    const tail = row.display_id.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (!Number.isNaN(n)) next = n + 1;
  }
  return `${prefix}${next}`;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  requester_friend_id: string;
  assignee_friend_id: string;
  due_at: string; // ISO 8601 +09:00
  line_account_id?: string | null;
}

export interface CreateTaskResult {
  task: Task;
  event: TaskEvent;
}

export async function createTask(
  db: D1Database,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  const now = new Date();
  const id = generateTaskId(now);
  const display_id = await nextDisplayId(db, now);
  const ts = toJstString(now);

  await db
    .prepare(
      `INSERT INTO tasks (id, display_id, title, description, requester_friend_id, assignee_friend_id,
        due_at, status, postpone_count, problem_count, overdue_alerted, line_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?)`,
    )
    .bind(
      id,
      display_id,
      input.title,
      input.description ?? null,
      input.requester_friend_id,
      input.assignee_friend_id,
      input.due_at,
      input.line_account_id ?? null,
      ts,
      ts,
    )
    .run();

  const event = await appendTaskEvent(db, {
    task_id: id,
    event_type: 'created',
    actor_friend_id: input.requester_friend_id,
    payload: { display_id, title: input.title, due_at: input.due_at },
  });

  const task = (await getTaskById(db, id)) as Task;
  return { task, event };
}

export async function getTaskById(db: D1Database, id: string): Promise<Task | null> {
  return db
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .bind(id)
    .first<Task>();
}

export async function getTaskByDisplayId(db: D1Database, displayId: string): Promise<Task | null> {
  return db
    .prepare(`SELECT * FROM tasks WHERE display_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(displayId)
    .first<Task>();
}

export interface ListTasksFilter {
  assignee_friend_id?: string;
  requester_friend_id?: string;
  statuses?: TaskStatus[];
  due_before?: string;
  due_after?: string;
  line_account_id?: string;
  limit?: number;
  offset?: number;
}

export async function listTasks(db: D1Database, filter: ListTasksFilter = {}): Promise<Task[]> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter.assignee_friend_id) {
    where.push('assignee_friend_id = ?');
    binds.push(filter.assignee_friend_id);
  }
  if (filter.requester_friend_id) {
    where.push('requester_friend_id = ?');
    binds.push(filter.requester_friend_id);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    const placeholders = filter.statuses.map(() => '?').join(',');
    where.push(`status IN (${placeholders})`);
    binds.push(...filter.statuses);
  }
  if (filter.due_before) {
    where.push('due_at < ?');
    binds.push(filter.due_before);
  }
  if (filter.due_after) {
    where.push('due_at >= ?');
    binds.push(filter.due_after);
  }
  if (filter.line_account_id) {
    where.push('line_account_id = ?');
    binds.push(filter.line_account_id);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  const result = await db
    .prepare(
      `SELECT * FROM tasks ${whereClause} ORDER BY due_at ASC, created_at ASC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<Task>();
  return result.results;
}

/** 期日超過していて、まだアラート発火していない pending/in_progress タスク。 */
export async function listOverdueUnalertedTasks(
  db: D1Database,
  nowIso: string = jstNow(),
): Promise<Task[]> {
  const result = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE due_at < ?
         AND status IN ('pending','in_progress')
         AND overdue_alerted = 0
       ORDER BY due_at ASC LIMIT 500`,
    )
    .bind(nowIso)
    .all<Task>();
  return result.results;
}

/** 期日が指定範囲 [from, to) にある未完了タスク (前日/当日リマインド用)。 */
export async function listTasksDueBetween(
  db: D1Database,
  fromIso: string,
  toIso: string,
): Promise<Task[]> {
  const result = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE due_at >= ? AND due_at < ?
         AND status IN ('pending','in_progress')
       ORDER BY due_at ASC LIMIT 500`,
    )
    .bind(fromIso, toIso)
    .all<Task>();
  return result.results;
}

// ── 状態遷移 ────────────────────────────────────────────────────────────────

export async function markTaskStarted(
  db: D1Database,
  id: string,
  actor: string,
): Promise<Task | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('pending')`,
    )
    .bind(now, now, id)
    .run();
  await appendTaskEvent(db, {
    task_id: id,
    event_type: 'started',
    actor_friend_id: actor,
    payload: {},
  });
  return getTaskById(db, id);
}

export async function markTaskCompleted(
  db: D1Database,
  id: string,
  actor: string,
): Promise<Task | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?, overdue_alerted = 0
       WHERE id = ? AND status IN ('pending','in_progress','delayed','problem')`,
    )
    .bind(now, now, id)
    .run();
  await appendTaskEvent(db, {
    task_id: id,
    event_type: 'completed',
    actor_friend_id: actor,
    payload: {},
  });
  return getTaskById(db, id);
}

export async function markTaskCancelled(
  db: D1Database,
  id: string,
  actor: string,
  reason?: string,
): Promise<Task | null> {
  const now = jstNow();
  await db
    .prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`)
    .bind(now, id)
    .run();
  await appendTaskEvent(db, {
    task_id: id,
    event_type: 'cancelled',
    actor_friend_id: actor,
    payload: { reason: reason ?? null },
  });
  return getTaskById(db, id);
}

/**
 * 遅延報告: 担当者 (actor) が「+N日延期」ボタンを押下。
 * - due_at を N日後の同時刻に更新
 * - postpone_count++
 * - status を delayed に (もしくは元のまま続行)
 * - overdue_alerted = 0 (再アラート対象に戻す)
 * - delay_reported / postponed イベントを追記
 */
export async function reportTaskDelay(
  db: D1Database,
  id: string,
  actor: string,
  delayDays: number,
): Promise<Task | null> {
  const cur = await getTaskById(db, id);
  if (!cur) return null;
  const newDue = new Date(new Date(cur.due_at).getTime() + delayDays * 24 * 60 * 60_000);
  const newDueIso = toJstString(newDue);
  const now = jstNow();
  await db
    .prepare(
      `UPDATE tasks
       SET due_at = ?, postpone_count = postpone_count + 1,
           status = CASE WHEN status IN ('pending','delayed') THEN 'delayed'
                         WHEN status = 'in_progress' THEN 'in_progress'
                         ELSE status END,
           overdue_alerted = 0,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(newDueIso, now, id)
    .run();
  await appendTaskEvent(db, {
    task_id: id,
    event_type: 'delay_reported',
    actor_friend_id: actor,
    payload: { delay_days: delayDays, prev_due_at: cur.due_at, new_due_at: newDueIso },
  });
  await appendTaskEvent(db, {
    task_id: id,
    event_type: 'postponed',
    actor_friend_id: actor,
    payload: { delay_days: delayDays, new_due_at: newDueIso },
  });
  return getTaskById(db, id);
}

export async function reportTaskProblem(
  db: D1Database,
  id: string,
  actor: string,
  problem: { text: string; severity?: 'low' | 'medium' | 'high' },
): Promise<Task | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE tasks
       SET status = 'problem', problem_count = problem_count + 1, updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, id)
    .run();
  await appendTaskEvent(db, {
    task_id: id,
    event_type: 'problem_reported',
    actor_friend_id: actor,
    payload: { text: problem.text, severity: problem.severity ?? 'medium' },
  });
  return getTaskById(db, id);
}

export async function markOverdueAlerted(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE tasks SET overdue_alerted = 1, updated_at = ? WHERE id = ?`)
    .bind(jstNow(), id)
    .run();
  await appendTaskEvent(db, {
    task_id: id,
    event_type: 'overdue_alerted',
    actor_friend_id: null,
    payload: {},
  });
}

// ── イベント (履歴) ─────────────────────────────────────────────────────────

export interface AppendTaskEventInput {
  task_id: string;
  event_type: TaskEventType;
  actor_friend_id: string | null;
  payload?: Record<string, unknown>;
}

export async function appendTaskEvent(
  db: D1Database,
  input: AppendTaskEventInput,
): Promise<TaskEvent> {
  const id = crypto.randomUUID();
  const created_at = jstNow();
  const payload = JSON.stringify(input.payload ?? {});
  await db
    .prepare(
      `INSERT INTO task_events (id, task_id, event_type, actor_friend_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.task_id, input.event_type, input.actor_friend_id, payload, created_at)
    .run();
  return {
    id,
    task_id: input.task_id,
    event_type: input.event_type,
    actor_friend_id: input.actor_friend_id,
    payload,
    created_at,
  };
}

export async function listTaskEvents(
  db: D1Database,
  taskId: string,
  limit = 100,
): Promise<TaskEvent[]> {
  const result = await db
    .prepare(
      `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(taskId, limit)
    .all<TaskEvent>();
  return result.results;
}

// ── staff_metrics ───────────────────────────────────────────────────────────

export async function getStaffMetrics(
  db: D1Database,
  friendId: string,
): Promise<StaffMetrics> {
  const row = await db
    .prepare(`SELECT * FROM staff_metrics WHERE friend_id = ?`)
    .bind(friendId)
    .first<StaffMetrics>();
  if (row) return row;
  return {
    friend_id: friendId,
    no_report_count: 0,
    reported_on_time_count: 0,
    delay_report_count: 0,
    updated_at: jstNow(),
  };
}

export async function listStaffMetrics(db: D1Database): Promise<StaffMetrics[]> {
  const result = await db
    .prepare(`SELECT * FROM staff_metrics ORDER BY updated_at DESC`)
    .all<StaffMetrics>();
  return result.results;
}

type MetricKey = 'no_report_count' | 'reported_on_time_count' | 'delay_report_count';

export async function incrementStaffMetric(
  db: D1Database,
  friendId: string,
  key: MetricKey,
  delta = 1,
): Promise<void> {
  const now = jstNow();
  // upsert: insert default 0 row then UPDATE
  await db
    .prepare(
      `INSERT INTO staff_metrics (friend_id, no_report_count, reported_on_time_count, delay_report_count, updated_at)
       VALUES (?, 0, 0, 0, ?)
       ON CONFLICT(friend_id) DO NOTHING`,
    )
    .bind(friendId, now)
    .run();
  await db
    .prepare(`UPDATE staff_metrics SET ${key} = ${key} + ?, updated_at = ? WHERE friend_id = ?`)
    .bind(delta, now, friendId)
    .run();
}
