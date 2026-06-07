import { Hono } from 'hono';
import {
  createTask,
  getTaskById,
  getTaskByDisplayId,
  listTasks,
  listStaffMetrics,
  markTaskCompleted,
  markTaskCancelled,
  markCompletionByAssignee,
  markCompletionByRequester,
  reportTaskDelay,
  reportTaskProblem,
  updateTaskFields,
  appendTaskEvent,
  listTaskEvents,
  incrementStaffMetric,
  getFriendByLineUserId,
  getFriendById,
  isTimeBefore,
  jstNow,
  type Task,
  type Friend,
  type TaskStatus,
  type TaskPriority,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import {
  buildTaskCard,
  buildProblemReportCard,
  buildProgressReportNoticeCard,
  buildCompletionApprovalCard,
  buildCompletionNoticeCard,
} from '../services/task-flex.js';
import {
  insertTaskAttachment,
  listTaskAttachmentViews,
} from '../services/task-attachments.js';
import type { Env } from '../index.js';

// =============================================================================
// HD TaskBot — Tasks routes
// =============================================================================
// Admin / staff: API key 認証 (Bearer)
// LIFF:         lineUserId ベースで friend を解決 (auth-skip path: /api/liff/*)
// =============================================================================

const tasks = new Hono<Env>();

const ADMIN_TAG_NAME = 'role:admin';

function serializeTask(t: Task) {
  return {
    id: t.id,
    displayId: t.display_id,
    title: t.title,
    description: t.description,
    requesterFriendId: t.requester_friend_id,
    assigneeFriendId: t.assignee_friend_id,
    dueAt: t.due_at,
    status: t.status,
    priority: t.priority,
    startedAt: t.started_at,
    completedAt: t.completed_at,
    postponeCount: t.postpone_count,
    problemCount: t.problem_count,
    overdueAlerted: Boolean(t.overdue_alerted),
    lineAccountId: t.line_account_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    // 2段階承認 (migration 030)
    completionAssigneeMarkedAt: t.completion_assignee_marked_at,
    completionRequesterMarkedAt: t.completion_requester_marked_at,
    problemResolvedAssigneeAt: t.problem_resolved_assignee_at,
    problemResolvedRequesterAt: t.problem_resolved_requester_at,
  };
}

function normalizePriority(input: unknown): TaskPriority {
  if (input === 'high' || input === 'medium' || input === 'low') return input;
  return 'medium';
}

async function friendHasAdminRole(db: D1Database, friendId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM friend_tags ft
       INNER JOIN tags t ON t.id = ft.tag_id
       WHERE ft.friend_id = ? AND t.name = ?
       LIMIT 1`,
    )
    .bind(friendId, ADMIN_TAG_NAME)
    .first();
  return Boolean(row);
}

/**
 * タスク作成時に担当者へカード通知を push する。
 * 担当者 == 依頼者 でも送る (LIFF送信完了の確認になる)。
 * push 失敗はログのみで握り潰し、API レスポンスは成功扱い。
 */
async function pushTaskAssignedNotice(
  env: Env['Bindings'],
  task: Task,
  assignee: Friend,
): Promise<void> {
  if (!assignee.line_user_id) return;
  try {
    const client = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
    const attachments = await listTaskAttachmentViews(env.DB, task.id, env.WORKER_URL);
    const card = buildTaskCard({
      task,
      assigneeName: assignee.display_name ?? null,
      actions: ['start', 'complete_assignee', 'delay_menu', 'problem'],
      showDescription: true,
      attachments,
    });
    await client.pushFlexMessage(
      assignee.line_user_id,
      `📌 新しいタスク依頼: ${task.title}`,
      card as never,
    );
  } catch (err) {
    console.error('pushTaskAssignedNotice failed', { taskId: task.id, err });
  }
}

/**
 * 問題報告時に push 通知を送る。
 * 通知先: 報告者本人を除く {担当者, 依頼者, role:admin タグ持ちの全員}
 *   - 重複 friend_id を排除
 *   - line_user_id が無い friend はスキップ
 *   - push 失敗はログのみで握り潰し (報告自体は成功扱い)
 */
async function pushTaskProblemNotice(
  env: Env['Bindings'],
  task: Task,
  problem: { text: string; severity: 'low' | 'medium' | 'high' },
  reporterFriendId: string,
): Promise<void> {
  try {
    const client = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
    const [assignee, requester, reporter, admins] = await Promise.all([
      getFriendById(env.DB, task.assignee_friend_id),
      getFriendById(env.DB, task.requester_friend_id),
      getFriendById(env.DB, reporterFriendId),
      env.DB
        .prepare(
          `SELECT f.* FROM friends f
           INNER JOIN friend_tags ft ON ft.friend_id = f.id
           INNER JOIN tags t ON t.id = ft.tag_id
           WHERE t.name = ?`,
        )
        .bind(ADMIN_TAG_NAME)
        .all<Friend>(),
    ]);
    const seen = new Set<string>([reporterFriendId]);
    const targets: Friend[] = [];
    const tryAdd = (f: Friend | null | undefined) => {
      if (!f) return;
      if (seen.has(f.id)) return;
      if (!f.line_user_id) return;
      seen.add(f.id);
      targets.push(f);
    };
    tryAdd(assignee);
    tryAdd(requester);
    for (const a of admins.results) tryAdd(a);

    if (targets.length === 0) return;

    const card = buildProblemReportCard({
      task,
      assigneeName: assignee?.display_name ?? null,
      reporterName: reporter?.display_name ?? null,
      text: problem.text,
      severity: problem.severity,
    });
    const altText = `⚠️ 問題報告: ${task.title}`;
    await Promise.all(
      targets.map((f) =>
        client
          .pushFlexMessage(f.line_user_id!, altText, card as never)
          .catch((err) => console.error('pushTaskProblemNotice item failed', { taskId: task.id, friendId: f.id, err })),
      ),
    );
  } catch (err) {
    console.error('pushTaskProblemNotice failed', { taskId: task.id, err });
  }
}

/**
 * 期日内 (due_at >= now) のうちに「完了 or 遅延報告」ボタンが押された場合は
 * "申告できた" カウンタを伸ばす。期日超過後の操作はカウントしない。
 */
async function bumpReportedOnTimeIfDueRespected(
  db: D1Database,
  task: Task,
  friendId: string,
): Promise<void> {
  const now = jstNow();
  if (isTimeBefore(now, task.due_at)) {
    await incrementStaffMetric(db, friendId, 'reported_on_time_count');
  }
}

// ── Authenticated API (admin / staff) ───────────────────────────────────────

/** POST /api/tasks — タスク作成 */
tasks.post('/api/tasks', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      description?: string | null;
      requesterFriendId: string;
      assigneeFriendId: string;
      dueAt: string;
      lineAccountId?: string | null;
    }>();

    if (!body.title?.trim()) return c.json({ success: false, error: 'title is required' }, 400);
    if (!body.requesterFriendId) return c.json({ success: false, error: 'requesterFriendId is required' }, 400);
    if (!body.assigneeFriendId) return c.json({ success: false, error: 'assigneeFriendId is required' }, 400);
    if (!body.dueAt) return c.json({ success: false, error: 'dueAt is required' }, 400);

    const requester = await getFriendById(c.env.DB, body.requesterFriendId);
    const assignee = await getFriendById(c.env.DB, body.assigneeFriendId);
    if (!requester || !assignee) {
      return c.json({ success: false, error: 'requester or assignee friend not found' }, 404);
    }

    const { task } = await createTask(c.env.DB, {
      title: body.title.trim().slice(0, 200),
      description: body.description?.trim() || null,
      requester_friend_id: body.requesterFriendId,
      assignee_friend_id: body.assigneeFriendId,
      due_at: body.dueAt,
      line_account_id: body.lineAccountId ?? null,
    });

    await pushTaskAssignedNotice(c.env, task, assignee);

    return c.json({ success: true, data: serializeTask(task) });
  } catch (err) {
    console.error('POST /api/tasks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** GET /api/tasks — タスク一覧 */
tasks.get('/api/tasks', async (c) => {
  try {
    const url = new URL(c.req.url);
    const statusesParam = url.searchParams.get('statuses');
    const items = await listTasks(c.env.DB, {
      assignee_friend_id: url.searchParams.get('assignee') ?? undefined,
      requester_friend_id: url.searchParams.get('requester') ?? undefined,
      statuses: statusesParam
        ? (statusesParam.split(',').map((s) => s.trim()) as TaskStatus[])
        : undefined,
      due_before: url.searchParams.get('due_before') ?? undefined,
      due_after: url.searchParams.get('due_after') ?? undefined,
      line_account_id: url.searchParams.get('account') ?? undefined,
      limit: url.searchParams.get('limit') ? Math.min(Number(url.searchParams.get('limit')), 500) : 100,
      offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0,
    });
    return c.json({ success: true, data: items.map(serializeTask) });
  } catch (err) {
    console.error('GET /api/tasks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** GET /api/tasks/:id — タスク詳細 (display_id でも検索可: ?byDisplay=1) */
tasks.get('/api/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const byDisplay = c.req.query('byDisplay') === '1';
    const task = byDisplay ? await getTaskByDisplayId(c.env.DB, id) : await getTaskById(c.env.DB, id);
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404);
    const events = await listTaskEvents(c.env.DB, task.id, 100);
    return c.json({ success: true, data: { task: serializeTask(task), events } });
  } catch (err) {
    console.error('GET /api/tasks/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** PATCH /api/tasks/:id — ステータス変更 (complete / cancel) */
tasks.patch('/api/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ action: 'complete' | 'cancel'; actorFriendId: string; reason?: string }>();
    if (!body.actorFriendId) return c.json({ success: false, error: 'actorFriendId is required' }, 400);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);

    if (body.action === 'complete') {
      const updated = await markTaskCompleted(c.env.DB, id, body.actorFriendId);
      await bumpReportedOnTimeIfDueRespected(c.env.DB, cur, body.actorFriendId);
      return c.json({ success: true, data: updated ? serializeTask(updated) : null });
    }
    if (body.action === 'cancel') {
      const updated = await markTaskCancelled(c.env.DB, id, body.actorFriendId, body.reason);
      return c.json({ success: true, data: updated ? serializeTask(updated) : null });
    }
    return c.json({ success: false, error: 'unknown action' }, 400);
  } catch (err) {
    console.error('PATCH /api/tasks/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/tasks/:id/postpone — 遅延報告 (+N日) */
tasks.post('/api/tasks/:id/postpone', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ delayDays: number; actorFriendId: string }>();
    const days = Math.max(1, Math.min(7, Math.floor(body.delayDays)));
    if (!body.actorFriendId) return c.json({ success: false, error: 'actorFriendId is required' }, 400);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);
    const updated = await reportTaskDelay(c.env.DB, id, body.actorFriendId, days);
    await incrementStaffMetric(c.env.DB, body.actorFriendId, 'delay_report_count');
    await bumpReportedOnTimeIfDueRespected(c.env.DB, cur, body.actorFriendId);
    return c.json({ success: true, data: updated ? serializeTask(updated) : null });
  } catch (err) {
    console.error('POST /api/tasks/:id/postpone error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/tasks/:id/problem — 問題報告 */
tasks.post('/api/tasks/:id/problem', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ actorFriendId: string; text: string; severity?: 'low' | 'medium' | 'high' }>();
    if (!body.actorFriendId) return c.json({ success: false, error: 'actorFriendId is required' }, 400);
    if (!body.text?.trim()) return c.json({ success: false, error: 'text is required' }, 400);
    const updated = await reportTaskProblem(c.env.DB, id, body.actorFriendId, {
      text: body.text.trim(),
      severity: body.severity,
    });
    return c.json({ success: true, data: updated ? serializeTask(updated) : null });
  } catch (err) {
    console.error('POST /api/tasks/:id/problem error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/tasks/:id/events — 自由イベント追記 (例: 利用者からの依頼/提案) */
tasks.post('/api/tasks/:id/events', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ eventType: string; actorFriendId?: string | null; payload?: Record<string, unknown> }>();
    if (!body.eventType) return c.json({ success: false, error: 'eventType is required' }, 400);
    const event = await appendTaskEvent(c.env.DB, {
      task_id: id,
      event_type: body.eventType as never,
      actor_friend_id: body.actorFriendId ?? null,
      payload: body.payload ?? {},
    });
    return c.json({ success: true, data: event });
  } catch (err) {
    console.error('POST /api/tasks/:id/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── LIFF (public, lineUserId-based) ─────────────────────────────────────────

/**
 * POST /api/liff/tasks — LIFF タスク依頼フォームの送信
 *
 * Body:
 *   lineUserId    LIFFから取得した依頼者の LINE userId
 *   assigneeFriendId  担当者 friend id (LIFF 上で /api/friends から動的取得)
 *   title         タスク内容
 *   dueAt         ISO 8601 +09:00
 *   description?  詳細メモ
 */
tasks.post('/api/liff/tasks', async (c) => {
  try {
    const body = await c.req.json<{
      lineUserId: string;
      assigneeFriendId: string;
      title: string;
      dueAt: string;
      description?: string | null;
      priority?: string;
      attachments?: Array<{ key: string; fileName: string; mimeType?: string | null; size?: number | null }>;
    }>();
    if (!body.lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    if (!body.assigneeFriendId) return c.json({ success: false, error: 'assigneeFriendId required' }, 400);
    if (!body.title?.trim()) return c.json({ success: false, error: 'title required' }, 400);
    if (!body.dueAt) return c.json({ success: false, error: 'dueAt required' }, 400);

    const requester = await getFriendByLineUserId(c.env.DB, body.lineUserId);
    if (!requester) return c.json({ success: false, error: 'requester not registered as friend' }, 404);
    const assignee = await getFriendById(c.env.DB, body.assigneeFriendId);
    if (!assignee) return c.json({ success: false, error: 'assignee not found' }, 404);

    const { task } = await createTask(c.env.DB, {
      title: body.title.trim().slice(0, 200),
      description: body.description?.trim() || null,
      requester_friend_id: requester.id,
      assignee_friend_id: assignee.id,
      due_at: body.dueAt,
      line_account_id: requester.line_account_id ?? assignee.line_account_id ?? null,
      priority: normalizePriority(body.priority),
    });

    // 添付ファイル (アップロード済み R2 キー) をタスクに紐づける
    if (Array.isArray(body.attachments)) {
      for (const att of body.attachments.slice(0, 5)) {
        if (!att?.key || !att?.fileName) continue;
        await insertTaskAttachment(c.env.DB, {
          taskId: task.id,
          r2Key: att.key,
          fileName: att.fileName,
          mimeType: att.mimeType ?? null,
          size: typeof att.size === 'number' ? att.size : null,
          uploadedByFriendId: requester.id,
        });
      }
    }

    await pushTaskAssignedNotice(c.env, task, assignee);

    return c.json({ success: true, data: serializeTask(task) });
  } catch (err) {
    console.error('POST /api/liff/tasks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/uploads — 依頼フォームのファイル添付アップロード (multipart/form-data)
 *
 * Fields:
 *   file        添付ファイル (1リクエスト1ファイル)
 *   lineUserId  アップロード者の LINE userId (friend 登録チェック用)
 *
 * R2 (IMAGES バケット) に `att-<uuid>.<ext>` で保存し、キーとメタを返す。
 * クライアントは複数ファイルを順次アップロードし、得たキーを /api/liff/tasks に渡す。
 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

function safeExt(fileName: string, mimeType: string): string {
  const m = fileName.match(/\.([A-Za-z0-9]{1,8})$/);
  if (m) return m[1].toLowerCase();
  const sub = (mimeType.split('/')[1] || 'bin').toLowerCase();
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
}

tasks.post('/api/liff/uploads', async (c) => {
  try {
    const form = await c.req.formData();
    const lineUserId = String(form.get('lineUserId') ?? '');
    if (!lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    const uploader = await getFriendByLineUserId(c.env.DB, lineUserId);
    if (!uploader) return c.json({ success: false, error: 'not registered as friend' }, 404);

    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return c.json({ success: false, error: 'file required' }, 400);
    }
    const blob = file as unknown as { name?: string; type?: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };
    if (blob.size > MAX_ATTACHMENT_BYTES) {
      return c.json({ success: false, error: 'ファイルが大きすぎます (上限 10MB)' }, 400);
    }
    const fileName = (blob.name || 'file').slice(0, 255);
    const mimeType = blob.type || 'application/octet-stream';
    const data = await blob.arrayBuffer();
    const key = `att-${crypto.randomUUID()}.${safeExt(fileName, mimeType)}`;

    await c.env.IMAGES.put(key, data, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: fileName },
    });

    return c.json(
      { success: true, data: { key, fileName, mimeType, size: blob.size } },
      201,
    );
  } catch (err) {
    console.error('POST /api/liff/uploads error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /files/:key — 添付ファイルの公開配信 (R2 から stream)。
 * key は `att-<uuid>.<ext>` のフラット形式。元ファイル名で表示する。
 */
tasks.get('/files/:key', async (c) => {
  const key = c.req.param('key');
  const object = await c.env.IMAGES.get(key);
  if (!object) return c.json({ success: false, error: 'File not found' }, 404);

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.etag);
  const original = object.customMetadata?.originalFilename;
  if (original) {
    // 日本語ファイル名対応: RFC 5987 (filename*) でエンコード
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(original)}`);
  }
  return new Response(object.body, { headers });
});

/**
 * POST /api/liff/tasks/:id/progress — 進捗報告 (中間 / 1-3 / 2-3 リマインドのカード経由)
 *
 * Body:
 *   lineUserId  進捗を送る担当者の LINE userId
 *   text        進捗メモ (空不可)
 *
 * 担当者本人 + admin のみ送信可。
 * 送信時に reported_on_time_count を +1 し、依頼者 + admin に Flex で転送する。
 */
tasks.post('/api/liff/tasks/:id/progress', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ lineUserId: string; text: string }>();
    if (!body.lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    if (!body.text?.trim()) return c.json({ success: false, error: 'text required' }, 400);
    const actor = await getFriendByLineUserId(c.env.DB, body.lineUserId);
    if (!actor) return c.json({ success: false, error: 'actor not registered as friend' }, 404);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);
    const isAdmin = await friendHasAdminRole(c.env.DB, actor.id);
    if (!isAdmin && actor.id !== cur.assignee_friend_id) {
      return c.json({ success: false, error: '担当者のみ進捗報告できます' }, 403);
    }
    const text = body.text.trim().slice(0, 1000);
    await appendTaskEvent(c.env.DB, {
      task_id: id,
      event_type: 'progress_reported',
      actor_friend_id: actor.id,
      payload: { text },
    });
    await incrementStaffMetric(c.env.DB, actor.id, 'reported_on_time_count');

    // 依頼者 + admin (担当者本人と申告者を除く) に push
    try {
      const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      const requester = await getFriendById(c.env.DB, cur.requester_friend_id);
      const targets = new Map<string, Friend>();
      if (requester && requester.line_user_id && requester.id !== actor.id) {
        targets.set(requester.id, requester);
      }
      const admins = await c.env.DB
        .prepare(
          `SELECT f.* FROM friends f
           INNER JOIN friend_tags ft ON ft.friend_id = f.id
           INNER JOIN tags t ON t.id = ft.tag_id
           WHERE t.name = ? AND f.is_following = 1`,
        )
        .bind(ADMIN_TAG_NAME)
        .all<Friend>();
      for (const a of admins.results) {
        if (!a.line_user_id) continue;
        if (a.id === actor.id) continue;
        if (a.id === cur.assignee_friend_id) continue;
        targets.set(a.id, a);
      }
      const altText = `📝 ${actor.display_name ?? '担当者'}「${cur.title}」の進捗`;
      const card = buildProgressReportNoticeCard({
        task: cur,
        reporterName: actor.display_name ?? null,
        text,
      });
      for (const t of targets.values()) {
        try {
          await lineClient.pushFlexMessage(t.line_user_id!, altText, card as never);
        } catch (err) {
          console.error('progress_reported push failed', { friendId: t.id, err });
        }
      }
    } catch (err) {
      console.error('progress_reported push wrapper failed', err);
    }
    return c.json({ success: true });
  } catch (err) {
    console.error('POST /api/liff/tasks/:id/progress error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/tasks/:id/problem — LIFF 問題報告フォーム送信
 */
tasks.post('/api/liff/tasks/:id/problem', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ lineUserId: string; text: string; severity?: 'low' | 'medium' | 'high' }>();
    if (!body.lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    if (!body.text?.trim()) return c.json({ success: false, error: 'text required' }, 400);
    const actor = await getFriendByLineUserId(c.env.DB, body.lineUserId);
    if (!actor) return c.json({ success: false, error: 'actor not registered as friend' }, 404);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);
    // 担当者 / 依頼者 / admin 以外の問題報告は拒否
    const isAdmin = await friendHasAdminRole(c.env.DB, actor.id);
    if (!isAdmin && actor.id !== cur.assignee_friend_id && actor.id !== cur.requester_friend_id) {
      return c.json({ success: false, error: '権限がありません' }, 403);
    }
    const updated = await reportTaskProblem(c.env.DB, id, actor.id, {
      text: body.text.trim(),
      severity: body.severity,
    });
    if (updated) {
      await pushTaskProblemNotice(c.env, updated, {
        text: body.text.trim(),
        severity: body.severity ?? 'medium',
      }, actor.id);
    }
    return c.json({ success: true, data: updated ? serializeTask(updated) : null });
  } catch (err) {
    console.error('POST /api/liff/tasks/:id/problem error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/proposals — 利用者からの依頼/提案
 * 上司 (role:admin) 向けに「task_request_proposed」イベントを採番、各 admin に push 通知させる。
 * LIFF からは task_id なしで投稿、Worker 側で「placeholder task」を生成しイベントを残す。
 */
tasks.post('/api/liff/proposals', async (c) => {
  try {
    const body = await c.req.json<{
      lineUserId: string;
      kind: 'request' | 'propose';
      text: string;
      preferredDueAt?: string | null;
    }>();
    if (!body.lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    if (!body.text?.trim()) return c.json({ success: false, error: 'text required' }, 400);
    const actor = await getFriendByLineUserId(c.env.DB, body.lineUserId);
    if (!actor) return c.json({ success: false, error: 'actor not registered as friend' }, 404);

    // admin friends を取得 (タグ name = 'role:admin')
    const admins = await c.env.DB
      .prepare(
        `SELECT f.* FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         INNER JOIN tags t ON t.id = ft.tag_id
         WHERE t.name = ?`,
      )
      .bind(ADMIN_TAG_NAME)
      .all<{ id: string }>();

    if (admins.results.length === 0) {
      return c.json({ success: false, error: 'admin (role:admin) not configured yet' }, 412);
    }
    // 「placeholder」ではなく純粋に proposal を記録: task は作らずイベントテーブルだけに「proposal」を残すのは
    // schema 上 task_id NOT NULL のため、ここでは未使用。代わりに admin 全員へ通知する用に
    // serialized payload を返して、呼び出し側 (LIFF) が /api/notifications 等を経由するか
    // Worker が直接 line push する設計を採用。
    // → MVP では Worker 内で push せず、API レスポンスに admin friend ids を返して
    //   呼び出し側 (LIFF) は /api/liff/proposals/notify を別途呼ぶ二段階構成は避けたいため、
    //   直接 line push を行う方針。この処理は cron / push helper 側に切り出す。
    //   ここでは単に admin ids と payload を返却する MVP 実装。

    return c.json({
      success: true,
      data: {
        kind: body.kind,
        text: body.text.trim(),
        actorFriendId: actor.id,
        preferredDueAt: body.preferredDueAt ?? null,
        targetAdminIds: admins.results.map((r) => r.id),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/proposals error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/liff/staff-list — LIFF タスク依頼フォーム用の担当者候補一覧
 * role:staff or role:admin タグを持つ friend を返す。LIFF からは公開アクセス。
 */
tasks.get('/api/liff/staff-list', async (c) => {
  try {
    const result = await c.env.DB
      .prepare(
        `SELECT DISTINCT f.id, f.display_name
         FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         INNER JOIN tags t ON t.id = ft.tag_id
         WHERE t.name IN ('role:admin','role:staff') AND f.is_following = 1
         ORDER BY f.display_name ASC`,
      )
      .all<{ id: string; display_name: string | null }>();
    return c.json({
      success: true,
      data: result.results.map((r) => ({ id: r.id, displayName: r.display_name })),
    });
  } catch (err) {
    console.error('GET /api/liff/staff-list error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/liff/tasks?lineUserId=...&scope=mine|all
 *   - mine: 自分が assignee or requester のタスク
 *   - all : 自分が admin のときだけ全件 (それ以外は mine と同じ動作)
 */
tasks.get('/api/liff/tasks', async (c) => {
  try {
    const lineUserId = c.req.query('lineUserId');
    if (!lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    const me = await getFriendByLineUserId(c.env.DB, lineUserId);
    if (!me) return c.json({ success: false, error: 'not registered as friend' }, 404);
    const scope = c.req.query('scope') === 'all' ? 'all' : 'mine';
    const isAdmin = await friendHasAdminRole(c.env.DB, me.id);

    if (scope === 'all' && isAdmin) {
      const items = await listTasks(c.env.DB, {
        statuses: ['pending', 'in_progress', 'delayed', 'problem'],
      });
      return c.json({ success: true, data: items.map(serializeTask), me: { friendId: me.id, isAdmin: true } });
    }
    const mineAsAssignee = await listTasks(c.env.DB, {
      assignee_friend_id: me.id,
      statuses: ['pending', 'in_progress', 'delayed', 'problem'],
    });
    const mineAsRequester = await listTasks(c.env.DB, {
      requester_friend_id: me.id,
      statuses: ['pending', 'in_progress', 'delayed', 'problem'],
    });
    // 重複除去
    const map = new Map<string, ReturnType<typeof serializeTask>>();
    for (const t of mineAsAssignee) map.set(t.id, serializeTask(t));
    for (const t of mineAsRequester) map.set(t.id, serializeTask(t));
    return c.json({
      success: true,
      data: Array.from(map.values()),
      me: { friendId: me.id, isAdmin },
    });
  } catch (err) {
    console.error('GET /api/liff/tasks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── プロジェクト一覧 LIFF からのタスク操作 ────────────────────────────────────
//
// すべて lineUserId + taskId 必須。actor を friend として解決し、権限を判定する。
// 権限:
//   PATCH    /api/liff/tasks/:id            requester or admin
//   POST     /api/liff/tasks/:id/complete   assignee/requester/admin (kind 自動判定 or 明示)
//   POST     /api/liff/tasks/:id/postpone   assignee or admin
//   POST     /api/liff/tasks/:id/cancel     requester or admin

async function resolveActor(c: { env: Env['Bindings']; req: { json: () => Promise<unknown> } }) {
  const body = (await c.req.json()) as Record<string, unknown>;
  const lineUserId = String(body.lineUserId ?? '');
  if (!lineUserId) return { error: 'lineUserId required', body: null, actor: null };
  const actor = await getFriendByLineUserId(c.env.DB, lineUserId);
  if (!actor) return { error: 'actor not registered as friend', body: null, actor: null };
  return { error: null, body, actor };
}

/** PATCH /api/liff/tasks/:id — タイトル / メモ / 期日 / 優先度 編集 */
tasks.patch('/api/liff/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { error, body, actor } = await resolveActor(c);
    if (error || !body || !actor) return c.json({ success: false, error: error ?? 'bad request' }, 400);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);
    const isAdmin = await friendHasAdminRole(c.env.DB, actor.id);
    if (!isAdmin && actor.id !== cur.requester_friend_id) {
      return c.json({ success: false, error: '編集権限がありません (依頼者 or admin のみ)' }, 403);
    }
    const updated = await updateTaskFields(c.env.DB, id, actor.id, {
      title: typeof body.title === 'string' ? (body.title as string) : undefined,
      description:
        body.description === null
          ? null
          : typeof body.description === 'string'
            ? (body.description as string)
            : undefined,
      due_at: typeof body.dueAt === 'string' ? (body.dueAt as string) : undefined,
      priority:
        body.priority === 'high' || body.priority === 'medium' || body.priority === 'low'
          ? (body.priority as TaskPriority)
          : undefined,
    });
    return c.json({ success: true, data: updated ? serializeTask(updated) : null });
  } catch (err) {
    console.error('PATCH /api/liff/tasks/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/liff/tasks/:id/complete — 担当者 or 依頼者の片側完了マーク */
tasks.post('/api/liff/tasks/:id/complete', async (c) => {
  try {
    const id = c.req.param('id');
    const { error, body, actor } = await resolveActor(c);
    if (error || !body || !actor) return c.json({ success: false, error: error ?? 'bad request' }, 400);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);
    const isAdmin = await friendHasAdminRole(c.env.DB, actor.id);
    const isAssignee = actor.id === cur.assignee_friend_id;
    const isRequester = actor.id === cur.requester_friend_id;
    let kind: 'assignee' | 'requester' | null =
      body.kind === 'assignee' || body.kind === 'requester' ? (body.kind as 'assignee' | 'requester') : null;
    if (!kind) {
      if (isAssignee) kind = 'assignee';
      else if (isRequester) kind = 'requester';
      else if (isAdmin) kind = 'assignee';
      else return c.json({ success: false, error: '権限がありません' }, 403);
    }
    if (kind === 'assignee' && !(isAssignee || isAdmin)) {
      return c.json({ success: false, error: '担当者用の操作です' }, 403);
    }
    if (kind === 'requester' && !(isRequester || isAdmin)) {
      return c.json({ success: false, error: '依頼者用の操作です' }, 403);
    }
    const result =
      kind === 'assignee'
        ? await markCompletionByAssignee(c.env.DB, id, actor.id)
        : await markCompletionByRequester(c.env.DB, id, actor.id);
    if (kind === 'assignee' && !result.alreadyMarked && isTimeBefore(jstNow(), cur.due_at)) {
      await incrementStaffMetric(c.env.DB, actor.id, 'reported_on_time_count');
    }
    const updated = result.task ?? cur;
    // push 通知 (相手側 or 双方)
    try {
      const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      const assignee = await getFriendById(c.env.DB, cur.assignee_friend_id);
      const requester = await getFriendById(c.env.DB, cur.requester_friend_id);
      if (result.finalized) {
        const elapsed = Math.max(
          1,
          Math.ceil((Date.now() - new Date(cur.created_at).getTime()) / (24 * 60 * 60_000)),
        );
        const card = buildCompletionNoticeCard(updated, assignee?.display_name ?? null, elapsed);
        const altText = `「${cur.title}」が完了しました`;
        const targets = [assignee, requester].filter(
          (f): f is Friend => !!f && !!f.line_user_id && f.line_user_id !== actor.line_user_id,
        );
        for (const t of targets) {
          try {
            await lineClient.pushFlexMessage(t.line_user_id!, altText, card as never);
          } catch (err) {
            console.error('completion finalized push failed', { friendId: t.id, err });
          }
        }
      } else if (!result.alreadyMarked) {
        if (kind === 'assignee') {
          if (requester && requester.line_user_id && requester.line_user_id !== actor.line_user_id) {
            await lineClient.pushFlexMessage(
              requester.line_user_id,
              `「${cur.title}」の完了承認をお願いします`,
              buildCompletionApprovalCard({
                task: updated,
                assigneeName: assignee?.display_name ?? null,
                requesterName: requester.display_name ?? null,
                kind: 'assignee_first',
              }) as never,
            );
          }
        } else {
          if (assignee && assignee.line_user_id && assignee.line_user_id !== actor.line_user_id) {
            await lineClient.pushFlexMessage(
              assignee.line_user_id,
              `「${cur.title}」の事前承認が届きました`,
              buildCompletionApprovalCard({
                task: updated,
                assigneeName: assignee.display_name ?? null,
                requesterName: requester?.display_name ?? null,
                kind: 'requester_first',
              }) as never,
            );
          }
        }
      }
    } catch (err) {
      console.error('completion push wrapper failed', err);
    }
    return c.json({
      success: true,
      data: { task: serializeTask(updated), finalized: result.finalized, alreadyMarked: result.alreadyMarked, kind },
    });
  } catch (err) {
    console.error('POST /api/liff/tasks/:id/complete error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/liff/tasks/:id/postpone — 遅延報告 (+N日)、担当者 or admin */
tasks.post('/api/liff/tasks/:id/postpone', async (c) => {
  try {
    const id = c.req.param('id');
    const { error, body, actor } = await resolveActor(c);
    if (error || !body || !actor) return c.json({ success: false, error: error ?? 'bad request' }, 400);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);
    const isAdmin = await friendHasAdminRole(c.env.DB, actor.id);
    if (!isAdmin && actor.id !== cur.assignee_friend_id) {
      return c.json({ success: false, error: '担当者 or admin のみ遅延報告できます' }, 403);
    }
    const days = Number(body.days ?? 0);
    if (!Number.isFinite(days) || days < 1 || days > 30) {
      return c.json({ success: false, error: 'days must be 1-30' }, 400);
    }
    const updated = await reportTaskDelay(c.env.DB, id, actor.id, days);
    await incrementStaffMetric(c.env.DB, actor.id, 'delay_report_count');
    return c.json({ success: true, data: updated ? serializeTask(updated) : null });
  } catch (err) {
    console.error('POST /api/liff/tasks/:id/postpone error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/liff/tasks/:id/cancel — 取消、依頼者 or admin */
tasks.post('/api/liff/tasks/:id/cancel', async (c) => {
  try {
    const id = c.req.param('id');
    const { error, body, actor } = await resolveActor(c);
    if (error || !body || !actor) return c.json({ success: false, error: error ?? 'bad request' }, 400);
    const cur = await getTaskById(c.env.DB, id);
    if (!cur) return c.json({ success: false, error: 'Task not found' }, 404);
    const isAdmin = await friendHasAdminRole(c.env.DB, actor.id);
    if (!isAdmin && actor.id !== cur.requester_friend_id) {
      return c.json({ success: false, error: '依頼者 or admin のみ取消できます' }, 403);
    }
    const reason = typeof body.reason === 'string' ? (body.reason as string).slice(0, 500) : null;
    const updated = await markTaskCancelled(c.env.DB, id, actor.id, reason ?? undefined);
    return c.json({ success: true, data: updated ? serializeTask(updated) : null });
  } catch (err) {
    console.error('POST /api/liff/tasks/:id/cancel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/liff/projects?lineUserId=...&tab=mine|all|done|active|metrics
 *
 * プロジェクト一覧ページ専用エンドポイント。タブごとに最適化された結果を返す。
 *
 *   mine    自分の assignee + requester (全 status)
 *   all     全タスク (admin only) — pending/in_progress/delayed/problem
 *   done    完了タスク — admin=全件, staff=自分が assignee or requester
 *   active  進行中タスク (pending/in_progress/delayed/problem) — 同上
 *   metrics 全 staff_metrics + display_name (admin only)
 *
 * staff が all / metrics をリクエストすると 403。
 */
tasks.get('/api/liff/projects', async (c) => {
  try {
    const lineUserId = c.req.query('lineUserId');
    if (!lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    const me = await getFriendByLineUserId(c.env.DB, lineUserId);
    if (!me) return c.json({ success: false, error: 'not registered as friend' }, 404);
    const isAdmin = await friendHasAdminRole(c.env.DB, me.id);
    const tab = c.req.query('tab') ?? 'mine';

    if ((tab === 'all' || tab === 'metrics') && !isAdmin) {
      return c.json({ success: false, error: 'admin only' }, 403);
    }

    const namesMap = new Map<string, string | null>();
    async function attachNames(rows: Task[]) {
      const ids = new Set<string>();
      for (const t of rows) {
        ids.add(t.assignee_friend_id);
        ids.add(t.requester_friend_id);
      }
      for (const id of ids) {
        if (namesMap.has(id)) continue;
        const f = await getFriendById(c.env.DB, id);
        namesMap.set(id, f?.display_name ?? null);
      }
    }
    function withNames(rows: Task[]) {
      return rows.map((t) => ({
        ...serializeTask(t),
        assigneeName: namesMap.get(t.assignee_friend_id) ?? null,
        requesterName: namesMap.get(t.requester_friend_id) ?? null,
      }));
    }

    if (tab === 'metrics') {
      const rows = await listStaffMetrics(c.env.DB);
      const detailed = await Promise.all(
        rows.map(async (r) => {
          const f = await getFriendById(c.env.DB, r.friend_id);
          return {
            friendId: r.friend_id,
            displayName: f?.display_name ?? null,
            noReportCount: r.no_report_count,
            reportedOnTimeCount: r.reported_on_time_count,
            delayReportCount: r.delay_report_count,
          };
        }),
      );
      return c.json({
        success: true,
        data: detailed,
        me: { friendId: me.id, isAdmin: true },
      });
    }

    if (tab === 'all') {
      const items = await listTasks(c.env.DB, {
        statuses: ['pending', 'in_progress', 'delayed', 'problem'],
        limit: 500,
      });
      await attachNames(items);
      return c.json({
        success: true,
        data: withNames(items),
        me: { friendId: me.id, isAdmin: true },
      });
    }

    if (tab === 'done') {
      const allDone = await listTasks(c.env.DB, { statuses: ['done'], limit: 200 });
      const items = isAdmin
        ? allDone
        : allDone.filter(
            (t) => t.assignee_friend_id === me.id || t.requester_friend_id === me.id,
          );
      // 完了日 降順
      items.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
      await attachNames(items);
      return c.json({ success: true, data: withNames(items), me: { friendId: me.id, isAdmin } });
    }

    if (tab === 'active') {
      const allActive = await listTasks(c.env.DB, {
        statuses: ['in_progress', 'delayed'],
        limit: 300,
      });
      const items = isAdmin
        ? allActive
        : allActive.filter(
            (t) => t.assignee_friend_id === me.id || t.requester_friend_id === me.id,
          );
      await attachNames(items);
      return c.json({ success: true, data: withNames(items), me: { friendId: me.id, isAdmin } });
    }

    // default: mine — 自分が assignee or requester
    const mineAsAssignee = await listTasks(c.env.DB, {
      assignee_friend_id: me.id,
      statuses: ['pending', 'in_progress', 'delayed', 'problem'],
    });
    const mineAsRequester = await listTasks(c.env.DB, {
      requester_friend_id: me.id,
      statuses: ['pending', 'in_progress', 'delayed', 'problem'],
    });
    const map = new Map<string, Task>();
    for (const t of mineAsAssignee) map.set(t.id, t);
    for (const t of mineAsRequester) map.set(t.id, t);
    const items = Array.from(map.values());
    await attachNames(items);
    return c.json({ success: true, data: withNames(items), me: { friendId: me.id, isAdmin } });
  } catch (err) {
    console.error('GET /api/liff/projects error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { tasks };
