import { Hono } from 'hono';
import {
  createTask,
  getTaskById,
  getTaskByDisplayId,
  listTasks,
  markTaskCompleted,
  markTaskCancelled,
  reportTaskDelay,
  reportTaskProblem,
  appendTaskEvent,
  listTaskEvents,
  incrementStaffMetric,
  getFriendByLineUserId,
  getFriendById,
  isTimeBefore,
  jstNow,
  type Task,
  type TaskStatus,
} from '@line-crm/db';
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
    startedAt: t.started_at,
    completedAt: t.completed_at,
    postponeCount: t.postpone_count,
    problemCount: t.problem_count,
    overdueAlerted: Boolean(t.overdue_alerted),
    lineAccountId: t.line_account_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
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
    });

    return c.json({ success: true, data: serializeTask(task) });
  } catch (err) {
    console.error('POST /api/liff/tasks error:', err);
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

export { tasks };
