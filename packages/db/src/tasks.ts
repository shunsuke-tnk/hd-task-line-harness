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
  | 'reopened'
  // 2段階承認 (migration 030):
  | 'completion_proposed_by_assignee'
  | 'completion_proposed_by_requester'
  | 'completion_finalized'
  | 'problem_resolved_by_assignee'
  | 'problem_resolved_by_requester'
  | 'problem_finalized'
  // 段階リマインド + 社員日報 (migration 032):
  | 'progress_reminder_first'
  | 'progress_reminder_second'
  | 'progress_reported'
  | 'daily_report_requested'
  | 'daily_report_submitted'
  | 'member_type_changed';

export type TaskPriority = 'high' | 'medium' | 'low';

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
  // 2段階承認用 (migration 030)。NULL = まだ押されていない。
  completion_assignee_marked_at: string | null;
  completion_requester_marked_at: string | null;
  problem_resolved_assignee_at: string | null;
  problem_resolved_requester_at: string | null;
  // 優先度 (migration 031): デフォルト 'medium'
  priority: TaskPriority;
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
  priority?: TaskPriority; // default 'medium'
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

  const priority: TaskPriority = input.priority ?? 'medium';
  await db
    .prepare(
      `INSERT INTO tasks (id, display_id, title, description, requester_friend_id, assignee_friend_id,
        due_at, status, postpone_count, problem_count, overdue_alerted, line_account_id, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?, ?)`,
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
      priority,
      ts,
      ts,
    )
    .run();

  const event = await appendTaskEvent(db, {
    task_id: id,
    event_type: 'created',
    actor_friend_id: input.requester_friend_id,
    payload: { display_id, title: input.title, due_at: input.due_at, priority },
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
  priorities?: TaskPriority[];
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
  if (filter.priorities && filter.priorities.length > 0) {
    const placeholders = filter.priorities.map(() => '?').join(',');
    where.push(`priority IN (${placeholders})`);
    binds.push(...filter.priorities);
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

// ── 2段階承認: 完了 (migration 030) ──────────────────────────────────────────
//
// 担当者・依頼者の双方が「完了」を押下した時点で初めて status='done' に確定。
// 片側のみ押下した状態は status='in_progress' のまま、
// completion_assignee_marked_at / completion_requester_marked_at に時刻を記録。
//
// 設計メモ:
//   * 既に status='done' のタスクへの再呼び出しは no-op
//   * 既に同側がマーク済みなら時刻更新せずに finalize 判定だけ行う
//   * 双方マーク済みになったら status='done' + completed_at = max(両者) に確定し
//     completion_finalized イベントを 1 回だけ追記
// ----------------------------------------------------------------------------

export interface CompletionMarkResult {
  task: Task | null;
  finalized: boolean;
  alreadyMarked: boolean;
}

async function markCompletionSide(
  db: D1Database,
  id: string,
  actor: string,
  side: 'assignee' | 'requester',
): Promise<CompletionMarkResult> {
  const cur = await getTaskById(db, id);
  if (!cur) return { task: null, finalized: false, alreadyMarked: false };
  if (cur.status === 'done' || cur.status === 'cancelled') {
    return { task: cur, finalized: false, alreadyMarked: true };
  }
  const colMarked =
    side === 'assignee' ? 'completion_assignee_marked_at' : 'completion_requester_marked_at';
  const wasMarked =
    side === 'assignee'
      ? cur.completion_assignee_marked_at !== null
      : cur.completion_requester_marked_at !== null;
  const now = jstNow();
  if (!wasMarked) {
    await db
      .prepare(`UPDATE tasks SET ${colMarked} = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, id)
      .run();
    await appendTaskEvent(db, {
      task_id: id,
      event_type:
        side === 'assignee'
          ? 'completion_proposed_by_assignee'
          : 'completion_proposed_by_requester',
      actor_friend_id: actor,
      payload: {},
    });
  }
  // 再取得して finalize 判定
  const after = await getTaskById(db, id);
  if (!after) return { task: null, finalized: false, alreadyMarked: wasMarked };
  if (
    after.completion_assignee_marked_at !== null &&
    after.completion_requester_marked_at !== null &&
    after.status !== 'done'
  ) {
    const finalizedAt = jstNow();
    await db
      .prepare(
        `UPDATE tasks
         SET status = 'done', completed_at = ?, updated_at = ?, overdue_alerted = 0
         WHERE id = ?`,
      )
      .bind(finalizedAt, finalizedAt, id)
      .run();
    await appendTaskEvent(db, {
      task_id: id,
      event_type: 'completion_finalized',
      actor_friend_id: actor,
      payload: {},
    });
    // 互換性のため completed イベントも追記 (旧集計を壊さない)
    await appendTaskEvent(db, {
      task_id: id,
      event_type: 'completed',
      actor_friend_id: actor,
      payload: { via: 'two_phase' },
    });
    return { task: await getTaskById(db, id), finalized: true, alreadyMarked: wasMarked };
  }
  return { task: after, finalized: false, alreadyMarked: wasMarked };
}

/** 担当者が「完了報告」を押下。 */
export async function markCompletionByAssignee(
  db: D1Database,
  id: string,
  actor: string,
): Promise<CompletionMarkResult> {
  return markCompletionSide(db, id, actor, 'assignee');
}

/** 依頼者が「完了承認」を押下。 */
export async function markCompletionByRequester(
  db: D1Database,
  id: string,
  actor: string,
): Promise<CompletionMarkResult> {
  return markCompletionSide(db, id, actor, 'requester');
}

// ── 2段階承認: 問題解決 (migration 030) ──────────────────────────────────────

export interface ProblemResolveResult {
  task: Task | null;
  finalized: boolean;
  alreadyMarked: boolean;
}

async function markProblemResolvedSide(
  db: D1Database,
  id: string,
  actor: string,
  side: 'assignee' | 'requester',
): Promise<ProblemResolveResult> {
  const cur = await getTaskById(db, id);
  if (!cur) return { task: null, finalized: false, alreadyMarked: false };
  // 既に status が problem 以外 (cancelled/done) ならスキップ
  if (cur.status !== 'problem') {
    return { task: cur, finalized: false, alreadyMarked: true };
  }
  const colResolved =
    side === 'assignee' ? 'problem_resolved_assignee_at' : 'problem_resolved_requester_at';
  const wasMarked =
    side === 'assignee'
      ? cur.problem_resolved_assignee_at !== null
      : cur.problem_resolved_requester_at !== null;
  const now = jstNow();
  if (!wasMarked) {
    await db
      .prepare(`UPDATE tasks SET ${colResolved} = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, id)
      .run();
    await appendTaskEvent(db, {
      task_id: id,
      event_type:
        side === 'assignee'
          ? 'problem_resolved_by_assignee'
          : 'problem_resolved_by_requester',
      actor_friend_id: actor,
      payload: {},
    });
  }
  const after = await getTaskById(db, id);
  if (!after) return { task: null, finalized: false, alreadyMarked: wasMarked };
  if (
    after.problem_resolved_assignee_at !== null &&
    after.problem_resolved_requester_at !== null
  ) {
    // 双方解決マーク → 問題終了。status は in_progress に戻し、完了の継続処理に乗せる
    const finalizedAt = jstNow();
    await db
      .prepare(
        `UPDATE tasks
         SET status = CASE WHEN started_at IS NULL THEN 'pending' ELSE 'in_progress' END,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(finalizedAt, id)
      .run();
    await appendTaskEvent(db, {
      task_id: id,
      event_type: 'problem_finalized',
      actor_friend_id: actor,
      payload: {},
    });
    return { task: await getTaskById(db, id), finalized: true, alreadyMarked: wasMarked };
  }
  return { task: after, finalized: false, alreadyMarked: wasMarked };
}

/** 担当者が「問題解決済み」をマーク。 */
export async function markProblemResolvedByAssignee(
  db: D1Database,
  id: string,
  actor: string,
): Promise<ProblemResolveResult> {
  return markProblemResolvedSide(db, id, actor, 'assignee');
}

/** 依頼者が「問題解決済み」をマーク。 */
export async function markProblemResolvedByRequester(
  db: D1Database,
  id: string,
  actor: string,
): Promise<ProblemResolveResult> {
  return markProblemResolvedSide(db, id, actor, 'requester');
}

/** 現在 status='problem' のタスク (両側 or 片側 解決待ち含む) を全件返す。 */
export async function listOpenProblems(db: D1Database): Promise<Task[]> {
  const result = await db
    .prepare(`SELECT * FROM tasks WHERE status = 'problem' ORDER BY due_at ASC, created_at ASC LIMIT 200`)
    .all<Task>();
  return result.results;
}

/** 直近の problem_reported event を返す (一覧表示で text/severity を取り出すため)。 */
export async function getLatestProblemReport(
  db: D1Database,
  taskId: string,
): Promise<{ text: string; severity: 'low' | 'medium' | 'high'; reporterFriendId: string | null; createdAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT actor_friend_id, payload, created_at FROM task_events
       WHERE task_id = ? AND event_type = 'problem_reported'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(taskId)
    .first<{ actor_friend_id: string | null; payload: string; created_at: string }>();
  if (!row) return null;
  let parsed: { text?: string; severity?: 'low' | 'medium' | 'high' } = {};
  try {
    parsed = JSON.parse(row.payload || '{}');
  } catch {
    /* ignore */
  }
  return {
    text: parsed.text ?? '',
    severity: parsed.severity ?? 'medium',
    reporterFriendId: row.actor_friend_id,
    createdAt: row.created_at,
  };
}

// ── 編集 (title / description / due_at / priority の部分更新) ─────────────────
//
// プロジェクト一覧 LIFF から呼ばれる。完了済 / 取消済タスクは編集不可。
// 呼出側で権限チェック (admin or requester) を行う想定。

export interface UpdateTaskFieldsInput {
  title?: string;
  description?: string | null;
  due_at?: string;
  priority?: TaskPriority;
}

export async function updateTaskFields(
  db: D1Database,
  id: string,
  actor: string | null,
  input: UpdateTaskFieldsInput,
): Promise<Task | null> {
  const cur = await getTaskById(db, id);
  if (!cur) return null;
  if (cur.status === 'done' || cur.status === 'cancelled') return cur;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.title !== undefined) {
    const v = input.title.trim().slice(0, 200);
    if (v && v !== cur.title) {
      sets.push('title = ?');
      binds.push(v);
    }
  }
  if (input.description !== undefined) {
    const v = input.description === null ? null : input.description.trim().slice(0, 2000);
    if (v !== cur.description) {
      sets.push('description = ?');
      binds.push(v);
    }
  }
  if (input.due_at !== undefined && input.due_at && input.due_at !== cur.due_at) {
    sets.push('due_at = ?');
    binds.push(input.due_at);
    // due_at を未来に動かしたら overdue フラグもクリア (再アラート対象に戻す)
    sets.push('overdue_alerted = 0');
  }
  if (input.priority !== undefined && input.priority !== cur.priority) {
    sets.push('priority = ?');
    binds.push(input.priority);
  }
  if (sets.length === 0) return cur; // no-op

  sets.push('updated_at = ?');
  binds.push(jstNow());
  binds.push(id);

  await db
    .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  // 編集の event_type は migration 未追加なので task_events には記録しない。
  // tasks.updated_at と field 自体の値で十分。`actor` は API 側で監査ログとして console.log されるだけ。
  void actor;

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
  // 新たな問題が発生した時点で、過去の解決マーク (両側) はリセット
  await db
    .prepare(
      `UPDATE tasks
       SET status = 'problem', problem_count = problem_count + 1, updated_at = ?,
           problem_resolved_assignee_at = NULL,
           problem_resolved_requester_at = NULL
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

/**
 * 指定 (task_id, event_type) の event が 1 件でもあれば true。
 * cron リマインドの冪等性チェック (二重送信防止) に使う。
 */
export async function hasTaskEventOfType(
  db: D1Database,
  taskId: string,
  eventType: TaskEventType,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM task_events WHERE task_id = ? AND event_type = ? LIMIT 1`,
    )
    .bind(taskId, eventType)
    .first();
  return Boolean(row);
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
