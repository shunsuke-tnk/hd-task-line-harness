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
  listTasks,
  listTasksDueBetween,
  markOverdueAlerted,
  appendTaskEvent,
  hasTaskEventOfType,
  incrementStaffMetric,
  getFriendById,
  parseFriendMetadata,
  updateFriendMetadata,
  toJstString,
  jstNow,
  type Task,
  type Friend,
} from '@line-crm/db';
import {
  buildReminderCard,
  buildProgressReminderCard,
  buildDailyReportCard,
  flexMessage,
} from './task-flex.js';

const ADMIN_TAG_NAME = 'role:admin';
const EMPLOYEE_TAG_NAME = 'type:employee';
const DAY_MS = 24 * 60 * 60_000;

interface RunOptions {
  /** 強制的にリマインダー時刻を上書き (テスト用)。指定なければ現在時刻 (JST) で判断。 */
  forceHour?: number;
  forceMinute?: number;
  /** LIFF base URL (例 https://liff.line.me/<LIFF_ID>)。進捗報告ボタンの URI 組立に使用。 */
  liffBaseUrl?: string;
}

/** 環境変数フォールバック付きで LIFF base URL を解決。 */
function resolveLiffBaseUrl(opts: RunOptions): string {
  if (opts.liffBaseUrl) return opts.liffBaseUrl;
  // デフォルト: 本番 LIFF (LIFF_ID は wrangler.toml の VITE_LIFF_ID と同じ値)。
  // VITE_LIFF_ID は build-time なのでここで参照できない → ハードコードのフォールバック。
  return 'https://liff.line.me/2009971783-Szm9bLIC';
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

  // 3) 期日当日リマインド (09:00-09:04 のみ) + 進捗リマインド (同時刻に発火)
  if (hour === 9 && minute < 5) {
    try {
      await runDayOfReminder(db, lineClient);
    } catch (err) {
      console.error('runDayOfReminder error', err);
    }
    try {
      await runProgressReminder(db, lineClient, resolveLiffBaseUrl(opts));
    } catch (err) {
      console.error('runProgressReminder error', err);
    }
  }

  // 4) 社員向け日報リマインド (09:30-09:34、当日リマインドと 30 分ずらし衝突回避)
  if (hour === 9 && minute >= 25 && minute < 35) {
    try {
      await runEmployeeDailyReport(db, lineClient, resolveLiffBaseUrl(opts));
    } catch (err) {
      console.error('runEmployeeDailyReport error', err);
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

// ── 進捗リマインド (中間 / 1-3 / 2-3) ─────────────────────────────────────────
//
// 期日まで日数 D = floor((due_at - created_at) / day)、経過 elapsed = floor((now - created_at) / day)
//   D <= 5  : 進捗リマインド無し (前日/当日のみ)
//   D 6-8   : elapsed == ceil(D/2) で 1 回
//   D >= 9  : elapsed == ceil(D/3) と elapsed == ceil(2D/3) で 2 回
//
// 冪等性: task_id × event_type で task_events を引いて重複送信防止。

async function runProgressReminder(
  db: D1Database,
  lineClient: LineClient,
  liffBaseUrl: string,
): Promise<void> {
  const nowMs = Date.now();
  const tasks = await listTasks(db, {
    statuses: ['pending', 'in_progress', 'delayed'],
    limit: 500,
  });
  for (const task of tasks) {
    const createdMs = new Date(task.created_at).getTime();
    const dueMs = new Date(task.due_at).getTime();
    if (!Number.isFinite(createdMs) || !Number.isFinite(dueMs)) continue;
    if (dueMs <= nowMs) continue; // 期日超過は overdueAlert 側で扱う
    const totalDays = Math.floor((dueMs - createdMs) / DAY_MS);
    if (totalDays < 6) continue;
    const elapsedDays = Math.floor((nowMs - createdMs) / DAY_MS);

    if (totalDays >= 6 && totalDays <= 8) {
      const target = Math.ceil(totalDays / 2);
      if (elapsedDays === target) {
        await maybeSendProgress(db, lineClient, task, liffBaseUrl, 'progress_reminder_first', 'mid');
      }
    } else if (totalDays >= 9) {
      const t1 = Math.ceil(totalDays / 3);
      const t2 = Math.ceil((2 * totalDays) / 3);
      if (elapsedDays === t1) {
        await maybeSendProgress(db, lineClient, task, liffBaseUrl, 'progress_reminder_first', 'first');
      } else if (elapsedDays === t2) {
        await maybeSendProgress(db, lineClient, task, liffBaseUrl, 'progress_reminder_second', 'second');
      }
    }
  }
}

async function maybeSendProgress(
  db: D1Database,
  lineClient: LineClient,
  task: Task,
  liffBaseUrl: string,
  eventType: 'progress_reminder_first' | 'progress_reminder_second',
  kind: 'mid' | 'first' | 'second',
): Promise<void> {
  const already = await hasTaskEventOfType(db, task.id, eventType);
  if (already) return;
  const assignee = await getFriendById(db, task.assignee_friend_id);
  if (!assignee?.line_user_id) return;
  const liffUrl = `${liffBaseUrl.replace(/#.*$/, '')}#page=progress_report&taskId=${encodeURIComponent(task.id)}`;
  const card = buildProgressReminderCard({
    task,
    assigneeName: assignee.display_name ?? null,
    liffUrl,
    kind,
  });
  const altText =
    kind === 'mid'
      ? `🟡 中間進捗を共有してください: ${task.title}`
      : kind === 'first'
        ? `📍 1/3 経過、進捗を共有してください: ${task.title}`
        : `📍 2/3 経過、進捗を共有してください: ${task.title}`;
  try {
    await lineClient.pushMessage(assignee.line_user_id, [flexMessage(altText, card) as never]);
  } catch (err) {
    console.error(`progress reminder push failed (taskId=${task.id})`, err);
    return; // event_type は記録しない (再試行可)
  }
  await appendTaskEvent(db, {
    task_id: task.id,
    event_type: eventType,
    actor_friend_id: null,
    payload: { kind, sent_at: jstNow() },
  });
}

// ── 社員向け日報リマインド (毎朝 09:30 JST) ──────────────────────────────────
//
// type:employee タグを持つ active friend に対し、その人の active タスク一覧を含む
// Flex カードを 1 通送る。dedup は friends.metadata.last_daily_report_request_at で行う
// (JST 日付文字列の同日比較)。

function jstDateString(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60_000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function runEmployeeDailyReport(
  db: D1Database,
  lineClient: LineClient,
  liffBaseUrl: string,
): Promise<void> {
  const today = jstDateString();
  const employees = await db
    .prepare(
      `SELECT DISTINCT f.* FROM friends f
       INNER JOIN friend_tags ft ON ft.friend_id = f.id
       INNER JOIN tags t ON t.id = ft.tag_id
       WHERE t.name = ? AND f.is_following = 1`,
    )
    .bind(EMPLOYEE_TAG_NAME)
    .all<Friend>();

  for (const friend of employees.results) {
    if (!friend.line_user_id) continue;
    const meta = parseFriendMetadata(friend);
    if (meta['last_daily_report_request_at'] === today) continue;
    const active = await listTasks(db, {
      assignee_friend_id: friend.id,
      statuses: ['pending', 'in_progress', 'delayed', 'problem'],
      limit: 50,
    });
    if (active.length === 0) continue;
    const card = buildDailyReportCard({ tasks: active, liffBaseUrl });
    try {
      await lineClient.pushMessage(
        friend.line_user_id,
        [flexMessage(`☀️ 今日の進捗 (${active.length}件)`, card) as never],
      );
    } catch (err) {
      console.error(`daily_report push failed (friendId=${friend.id})`, err);
      continue;
    }
    await updateFriendMetadata(db, friend.id, {
      last_daily_report_request_at: today,
    });
  }
}
