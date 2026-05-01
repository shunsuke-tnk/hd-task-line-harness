// =============================================================================
// HD TaskBot — Task reminders cron
// =============================================================================
// Cloudflare Workers Cron Triggers (default: */5 * * * *) から呼ばれる。
//
// ジョブ:
//   1. 期日前日リマインド (毎日18:00 JST)        — 翌日が期限のタスクを担当者に push
//   2. 期日当日リマインド (毎日09:00 JST)        — 当日が期限のタスクを担当者に push
//   3. 期日超過アラート (5分毎、毎回検査)         — overdue_alerted=0 を発火 → 担当者+依頼者+admins に push
//                                                  + staff_metrics.no_report_count++
// =============================================================================

import type { LineClient } from '@line-crm/line-sdk';
import {
  listOverdueUnalertedTasks,
  listTasksDueBetween,
  markOverdueAlerted,
  appendTaskEvent,
  incrementStaffMetric,
  getFriendById,
  toJstString,
  jstNow,
  type Task,
} from '@line-crm/db';
import { buildReminderCard, flexMessage } from './task-flex.js';

const ADMIN_TAG_NAME = 'role:admin';

interface RunOptions {
  /** 強制的にリマインダー時刻を上書き (テスト用)。指定なければ現在時刻 (JST) で判断。 */
  forceHour?: number;
  forceMinute?: number;
}

/**
 * Entry point — `apps/worker/src/index.ts` の scheduled handler から呼ばれる。
 * - 5分毎: 期日超過アラート
 * - 09時台ぴったりの run: 期日当日リマインド
 * - 18時台ぴったりの run: 期日前日リマインド
 * （Worker Cron は5分間隔なので、09:00/18:00 ジャストの run のみ実行する）
 */
export async function processTaskReminders(
  db: D1Database,
  lineClient: LineClient,
  opts: RunOptions = {},
): Promise<void> {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60_000);
  const hour = opts.forceHour ?? jst.getUTCHours();
  const minute = opts.forceMinute ?? jst.getUTCMinutes();

  // 1) 超過アラート (毎回)
  try {
    await runOverdueAlert(db, lineClient);
  } catch (err) {
    console.error('runOverdueAlert error', err);
  }

  // 2) 期日前日リマインド (18:00-18:04 のみ)
  if (hour === 18 && minute < 5) {
    try {
      await runDayBeforeReminder(db, lineClient);
    } catch (err) {
      console.error('runDayBeforeReminder error', err);
    }
  }

  // 3) 期日当日リマインド (09:00-09:04 のみ)
  if (hour === 9 && minute < 5) {
    try {
      await runDayOfReminder(db, lineClient);
    } catch (err) {
      console.error('runDayOfReminder error', err);
    }
  }
}

// ── 期日前日 ───────────────────────────────────────────────────────────────

async function runDayBeforeReminder(db: D1Database, lineClient: LineClient): Promise<void> {
  // 翌日 00:00 JST 〜 翌々日 00:00 JST に期日があるもの
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60_000);
  const startUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1, 0, 0, 0);
  const endUtc = startUtc + 24 * 60 * 60_000;
  const fromIso = toJstString(new Date(startUtc - 9 * 60 * 60_000));
  const toIso = toJstString(new Date(endUtc - 9 * 60 * 60_000));

  const tasks = await listTasksDueBetween(db, fromIso, toIso);
  for (const task of tasks) {
    await pushReminderToAssignee(db, lineClient, task, 'pre');
    await appendTaskEvent(db, {
      task_id: task.id,
      event_type: 'remind_pre',
      actor_friend_id: null,
      payload: { sent_at: jstNow() },
    });
  }
}

// ── 期日当日 ───────────────────────────────────────────────────────────────

async function runDayOfReminder(db: D1Database, lineClient: LineClient): Promise<void> {
  // 当日 00:00 JST 〜 翌日 00:00 JST
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60_000);
  const startUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 0, 0, 0);
  const endUtc = startUtc + 24 * 60 * 60_000;
  const fromIso = toJstString(new Date(startUtc - 9 * 60 * 60_000));
  const toIso = toJstString(new Date(endUtc - 9 * 60 * 60_000));

  const tasks = await listTasksDueBetween(db, fromIso, toIso);
  for (const task of tasks) {
    await pushReminderToAssignee(db, lineClient, task, 'today');
    await appendTaskEvent(db, {
      task_id: task.id,
      event_type: 'remind_today',
      actor_friend_id: null,
      payload: { sent_at: jstNow() },
    });
  }
}

// ── 期日超過 ───────────────────────────────────────────────────────────────

async function runOverdueAlert(db: D1Database, lineClient: LineClient): Promise<void> {
  const tasks = await listOverdueUnalertedTasks(db);
  for (const task of tasks) {
    // 1) 担当者に push
    await pushReminderToAssignee(db, lineClient, task, 'overdue');
    // 2) 依頼者にも push (担当者と異なる場合)
    if (task.requester_friend_id !== task.assignee_friend_id) {
      const requester = await getFriendById(db, task.requester_friend_id);
      if (requester?.line_user_id) {
        await safePush(lineClient, requester.line_user_id, task, 'overdue');
      }
    }
    // 3) 全 admin に push (重複除外: 担当者/依頼者と異なる人のみ)
    const admins = await db
      .prepare(
        `SELECT f.id, f.line_user_id FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         INNER JOIN tags t ON t.id = ft.tag_id
         WHERE t.name = ? AND f.is_following = 1`,
      )
      .bind(ADMIN_TAG_NAME)
      .all<{ id: string; line_user_id: string }>();
    for (const admin of admins.results) {
      if (admin.id === task.assignee_friend_id) continue;
      if (admin.id === task.requester_friend_id) continue;
      await safePush(lineClient, admin.line_user_id, task, 'overdue');
    }
    // 4) flag + counter
    await markOverdueAlerted(db, task.id);
    await incrementStaffMetric(db, task.assignee_friend_id, 'no_report_count');
  }
}

// ── 共通 ───────────────────────────────────────────────────────────────────

async function pushReminderToAssignee(
  db: D1Database,
  lineClient: LineClient,
  task: Task,
  kind: 'pre' | 'today' | 'overdue',
): Promise<void> {
  const assignee = await getFriendById(db, task.assignee_friend_id);
  if (!assignee?.line_user_id) return;
  await safePush(lineClient, assignee.line_user_id, task, kind);
}

async function safePush(
  lineClient: LineClient,
  toUserId: string,
  task: Task,
  kind: 'pre' | 'today' | 'overdue',
): Promise<void> {
  try {
    const altText =
      kind === 'pre'
        ? `🔔 明日が期限: ${task.title}`
        : kind === 'today'
          ? `⏰ 本日が期限: ${task.title}`
          : `🚨 期日超過: ${task.title}`;
    const card = buildReminderCard(task, null, kind);
    const msg = flexMessage(altText, card);
    await lineClient.pushMessage(toUserId, [msg as never]);
  } catch (err) {
    console.error(`task reminder push failed (kind=${kind}, taskId=${task.id})`, err);
  }
}
