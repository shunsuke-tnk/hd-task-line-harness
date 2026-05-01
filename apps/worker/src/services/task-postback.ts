// =============================================================================
// HD TaskBot — Postback dispatcher
// =============================================================================
// LINE 友だちが リッチメニュー / Flex ボタン をタップすると postback イベントが
// 飛んでくる。`data` に `action=...` を含むものだけここで処理し、
// 既存の auto_replies マッチには進ませない (return true)。
//
// 対応 action:
//   task_request_open       — リッチメニュー「タスク依頼」(LIFFが基本だがフォールバック)
//   task_complete_menu      — リッチメニュー「完了報告」 (自分担当のカルーセルを返す)
//   task_delay_menu         — リッチメニュー「遅延報告」 (カルーセル → +N日メニュー)
//   task_problem_menu       — リッチメニュー「問題報告」(LIFFへ誘導)
//   task_list_mine          — リッチメニュー「タスク一覧 (自分)」
//   task_list_all           — リッチメニュー「タスク一覧 (全員)」 (admin only)
//   metrics_show            — リッチメニュー「遅延カウント」
//   request_or_propose_open — リッチメニュー「依頼/提案」(LIFFへ誘導)
//
//   task_start              — タスクカード [▶︎着手します]
//   task_complete           — タスクカード [🎉完了報告] → confirm 表示
//   task_complete_confirm   — confirm カード [はい完了]
//   task_delay_menu (id 付) — 個別タスクカードの [⏰遅延] → +1/+2/+3メニュー
//   task_postpone           — +N日メニュー [+N日]
//   task_problem_open       — タスクカード [⚠️問題報告] → LIFF URL を返信
//   task_cancel_confirm     — タスクカード [❌取り消し] → confirm
//   task_cancel_confirm_yes — confirm [はい取り消す]
//   task_detail             — タスクカード [📋詳細]
// =============================================================================

import type { LineClient } from '@line-crm/line-sdk';
import {
  getTaskById,
  listTasks,
  getFriendByLineUserId,
  getFriendById,
  markTaskStarted,
  markTaskCompleted,
  markTaskCancelled,
  reportTaskDelay,
  incrementStaffMetric,
  listStaffMetrics,
  isTimeBefore,
  jstNow,
  type Friend,
  type Task,
} from '@line-crm/db';
import {
  buildTaskCard,
  buildTaskCarousel,
  buildEmptyTaskBubble,
  buildDelayMenuCard,
  buildConfirmComplete,
  buildConfirmCancel,
  buildMetricsBubble,
  buildCompletionNoticeCard,
  flexMessage,
  textMessage,
  type TaskCardAction,
} from './task-flex.js';

const ADMIN_TAG_NAME = 'role:admin';

interface PostbackContext {
  db: D1Database;
  lineClient: LineClient;
  friend: Friend;
  replyToken: string;
  postbackData: string;
  liffUrl: string;
}

/**
 * Returns true if the postback was handled by HD TaskBot logic.
 * webhook.ts はこれが true の場合、auto_replies フォールバックをスキップする。
 */
export async function handleTaskPostback(ctx: PostbackContext): Promise<boolean> {
  const params = parsePostback(ctx.postbackData);
  const action = params.get('action');
  if (!action) return false;

  switch (action) {
    case 'noop':
      return true;

    case 'task_request_open':
      await replyText(
        ctx,
        `タスク依頼フォームをこちらから開いてください🙏\n${liffWith(ctx.liffUrl, 'task_request')}`,
      );
      return true;

    case 'task_complete_menu':
      await replyTaskCarouselForActor(ctx, ['complete', 'delay_menu']);
      return true;

    case 'task_delay_menu': {
      const id = params.get('id');
      if (id) {
        // 個別タスクの遅延メニュー (＋N日選択)
        const task = await getTaskById(ctx.db, id);
        if (!task) {
          await replyText(ctx, 'タスクが見つかりませんでした。');
          return true;
        }
        const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
        await replyFlex(
          ctx,
          `「${task.title}」の遅延報告`,
          buildDelayMenuCard(task, assignee?.display_name ?? null),
        );
        return true;
      }
      // メニューから来た場合: 自分担当のタスクをカルーセル表示 (各カードに [遅延] ボタン)
      await replyTaskCarouselForActor(ctx, ['delay_menu', 'complete']);
      return true;
    }

    case 'task_problem_menu':
    case 'task_problem_open':
      await replyText(
        ctx,
        `問題報告フォームをこちらから開いてください🙏\n${liffWith(ctx.liffUrl, 'task_problem', params.get('id') ? { taskId: params.get('id') as string } : undefined)}`,
      );
      return true;

    case 'task_list_mine':
      await replyTaskCarouselForActor(ctx, ['complete', 'delay_menu', 'detail']);
      return true;

    case 'task_list_all': {
      const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
      if (!isAdmin) {
        await replyText(ctx, 'この機能は管理者のみご利用いただけます。');
        return true;
      }
      const items = await listTasks(ctx.db, {
        statuses: ['pending', 'in_progress', 'delayed', 'problem'],
      });
      const enriched = await enrichTasks(ctx.db, items);
      await replyFlex(
        ctx,
        `アクティブタスク (${items.length}件)`,
        items.length === 0
          ? buildEmptyTaskBubble()
          : buildTaskCarousel(enriched.map((e) => ({ ...e, actions: ['detail'] as TaskCardAction[] }))),
      );
      return true;
    }

    case 'metrics_show': {
      const rows = await listStaffMetrics(ctx.db);
      const detailed = await Promise.all(
        rows.map(async (r) => {
          const f = await getFriendById(ctx.db, r.friend_id);
          return {
            displayName: f?.display_name ?? null,
            noReportCount: r.no_report_count,
            reportedOnTimeCount: r.reported_on_time_count,
            delayReportCount: r.delay_report_count,
          };
        }),
      );
      await replyFlex(ctx, 'タスク報告状況', buildMetricsBubble(detailed));
      return true;
    }

    case 'request_or_propose_open':
      await replyText(
        ctx,
        `依頼・提案フォームをこちらから開いてください🙏\n${liffWith(ctx.liffUrl, 'request_or_propose')}`,
      );
      return true;

    // ── 個別タスクのアクション ────────────────────────────────────────────

    case 'task_start': {
      const task = await assertOwnableTask(ctx, params.get('id'));
      if (!task) return true;
      const updated = await markTaskStarted(ctx.db, task.id, ctx.friend.id);
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      await replyFlex(
        ctx,
        '着手を記録しました',
        buildTaskCard({
          task: updated ?? task,
          assigneeName: assignee?.display_name ?? null,
          actions: ['complete', 'delay_menu', 'problem'],
        }),
      );
      return true;
    }

    case 'task_complete': {
      const task = await assertOwnableTask(ctx, params.get('id'));
      if (!task) return true;
      await replyFlex(ctx, '完了確認', buildConfirmComplete(task));
      return true;
    }

    case 'task_complete_confirm': {
      const task = await assertOwnableTask(ctx, params.get('id'));
      if (!task) return true;
      const before = task;
      const updated = await markTaskCompleted(ctx.db, task.id, ctx.friend.id);
      // 期日内に押せたなら "申告できた" カウンタ++
      if (isTimeBefore(jstNow(), before.due_at)) {
        await incrementStaffMetric(ctx.db, ctx.friend.id, 'reported_on_time_count');
      }
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      await replyFlex(
        ctx,
        '完了を記録しました',
        buildTaskCard({
          task: updated ?? task,
          assigneeName: assignee?.display_name ?? null,
          actions: [],
        }),
      );
      // 依頼者にも通知 (push)
      try {
        const requester = await getFriendById(ctx.db, task.requester_friend_id);
        if (requester && requester.line_user_id !== ctx.friend.line_user_id) {
          const elapsed = Math.max(
            1,
            Math.ceil((Date.now() - new Date(task.created_at).getTime()) / (24 * 60 * 60_000)),
          );
          await ctx.lineClient.pushFlexMessage(
            requester.line_user_id,
            `「${task.title}」が完了しました`,
            buildCompletionNoticeCard(updated ?? task, assignee?.display_name ?? null, elapsed) as never,
          );
        }
      } catch (err) {
        console.error('completion notice push failed', err);
      }
      return true;
    }

    case 'task_postpone': {
      const id = params.get('id');
      const days = Math.max(1, Math.min(7, Number(params.get('days') ?? '1')));
      const task = await assertOwnableTask(ctx, id);
      if (!task) return true;
      const before = task;
      const updated = await reportTaskDelay(ctx.db, task.id, ctx.friend.id, days);
      await incrementStaffMetric(ctx.db, ctx.friend.id, 'delay_report_count');
      if (isTimeBefore(jstNow(), before.due_at)) {
        await incrementStaffMetric(ctx.db, ctx.friend.id, 'reported_on_time_count');
      }
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      await replyFlex(
        ctx,
        `${days}日延期を記録しました`,
        buildTaskCard({
          task: updated ?? task,
          assigneeName: assignee?.display_name ?? null,
          actions: ['complete', 'delay_menu', 'problem'],
        }),
      );
      return true;
    }

    case 'task_cancel_confirm': {
      const task = await assertOwnableTask(ctx, params.get('id'));
      if (!task) return true;
      await replyFlex(ctx, '取り消し確認', buildConfirmCancel(task));
      return true;
    }

    case 'task_cancel_confirm_yes': {
      const task = await assertOwnableTask(ctx, params.get('id'));
      if (!task) return true;
      const updated = await markTaskCancelled(ctx.db, task.id, ctx.friend.id, 'user-cancelled');
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      await replyFlex(
        ctx,
        '取り消しました',
        buildTaskCard({
          task: updated ?? task,
          assigneeName: assignee?.display_name ?? null,
          actions: [],
        }),
      );
      return true;
    }

    case 'task_detail': {
      const task = await assertReadableTask(ctx, params.get('id'));
      if (!task) return true;
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      const isAssignee = task.assignee_friend_id === ctx.friend.id;
      const isRequester = task.requester_friend_id === ctx.friend.id;
      const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
      const actions: TaskCardAction[] = [];
      if (isAssignee || isAdmin) actions.push('complete', 'delay_menu', 'problem');
      if (isRequester || isAdmin) actions.push('cancel');
      await replyFlex(
        ctx,
        `${task.display_id} 詳細`,
        buildTaskCard({
          task,
          assigneeName: assignee?.display_name ?? null,
          actions,
        }),
      );
      return true;
    }
  }

  return false;
}

// ── ヘルパ ──────────────────────────────────────────────────────────────────

function parsePostback(data: string): URLSearchParams {
  // postback data は "action=...&id=...&days=2" のような URLSearchParams 互換文字列を想定
  return new URLSearchParams(data);
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

async function replyText(ctx: PostbackContext, text: string): Promise<void> {
  await ctx.lineClient.replyMessage(ctx.replyToken, [textMessage(text) as never]);
}

async function replyFlex(ctx: PostbackContext, altText: string, contents: unknown): Promise<void> {
  await ctx.lineClient.replyMessage(ctx.replyToken, [flexMessage(altText, contents) as never]);
}

async function enrichTasks(
  db: D1Database,
  items: Task[],
): Promise<Array<{ task: Task; assigneeName: string | null }>> {
  const out: Array<{ task: Task; assigneeName: string | null }> = [];
  for (const t of items) {
    const a = await getFriendById(db, t.assignee_friend_id);
    out.push({ task: t, assigneeName: a?.display_name ?? null });
  }
  return out;
}

async function replyTaskCarouselForActor(
  ctx: PostbackContext,
  actions: TaskCardAction[],
): Promise<void> {
  const items = await listTasks(ctx.db, {
    assignee_friend_id: ctx.friend.id,
    statuses: ['pending', 'in_progress', 'delayed', 'problem'],
  });
  const enriched = await enrichTasks(ctx.db, items);
  await replyFlex(
    ctx,
    items.length === 0 ? '対象のタスクはありません' : `タスク (${items.length}件)`,
    items.length === 0
      ? buildEmptyTaskBubble()
      : buildTaskCarousel(enriched.map((e) => ({ ...e, actions }))),
  );
}

/**
 * 担当者本人 / 依頼者 / admin のみ操作可。
 * 該当しない場合は reply を返してから null を返す。
 */
async function assertOwnableTask(
  ctx: PostbackContext,
  id: string | null,
): Promise<Task | null> {
  if (!id) {
    await replyText(ctx, 'タスクIDが見つかりません。');
    return null;
  }
  const task = await getTaskById(ctx.db, id);
  if (!task) {
    await replyText(ctx, 'タスクが見つかりませんでした。');
    return null;
  }
  const isAssignee = task.assignee_friend_id === ctx.friend.id;
  const isRequester = task.requester_friend_id === ctx.friend.id;
  const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
  if (!(isAssignee || isRequester || isAdmin)) {
    await replyText(ctx, 'このタスクへの操作権限がありません。');
    return null;
  }
  return task;
}

/** 詳細閲覧は緩めの権限 (assignee / requester / admin)。 */
async function assertReadableTask(ctx: PostbackContext, id: string | null): Promise<Task | null> {
  return assertOwnableTask(ctx, id);
}

function liffWith(base: string, page: string, extras?: Record<string, string>): string {
  const sep = base.includes('?') ? '&' : '?';
  const params = new URLSearchParams({ page });
  if (extras) for (const [k, v] of Object.entries(extras)) params.set(k, v);
  return `${base}${sep}${params.toString()}`;
}

// 未使用ヘルパ抑制
void getFriendByLineUserId;
