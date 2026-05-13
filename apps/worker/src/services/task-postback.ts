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
  markCompletionByAssignee,
  markCompletionByRequester,
  markProblemResolvedByAssignee,
  markProblemResolvedByRequester,
  listOpenProblems,
  getLatestProblemReport,
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
  buildCompletionApprovalCard,
  buildLiffOpenBubble,
  buildProblemMenuBubble,
  buildProblemCarousel,
  buildStaffApplicationNoticeCard,
  buildApplicationApprovedCard,
  buildApplicationRejectedCard,
  flexMessage,
  textMessage,
  type TaskCardAction,
  type ProblemListItem,
} from './task-flex.js';

// Rich Menu / Tag IDs (本番運用値、変更時は両方とも更新)
// v6/v5 (2026-05-12): 全員共通 6 ボタンレイアウト (タスク依頼/完了報告/遅延報告/問題報告/プロジェクト一覧/依頼・提案)
const RICH_MENU_ADMIN_ID = 'richmenu-145160d79b870d2c4088bd9b93f7d1bb';
const RICH_MENU_STAFF_ID = 'richmenu-a3c2e164e3f527d9dcfbb3bff985c437';
const TAG_ROLE_ADMIN_ID = 'a98b0ac0-41ee-4dee-bf6f-fb58432ea1fa';
const TAG_ROLE_STAFF_ID = '632eb650-f67f-4591-b7bc-66e079ac6d33';
const TAG_PENDING_STAFF_ID = '80392547-9c98-47fb-929c-dd07a7412594';
// migration 031 で seed する社員/委託 区分タグ
const TAG_TYPE_EMPLOYEE_ID = 'c6f3a6e0-30b1-4f3e-8a9a-9d52d7c4f001';
const TAG_TYPE_CONTRACTOR_ID = 'c6f3a6e0-30b1-4f3e-8a9a-9d52d7c4f002';

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
      await replyFlex(
        ctx,
        'タスク依頼フォーム',
        buildLiffOpenBubble({
          title: '📝 タスク依頼フォーム',
          description: 'お疲れさまです🙏\n下のボタンからフォームを開いてください',
          liffUrl: liffWith(ctx.liffUrl, 'task_request'),
          buttonLabel: 'フォームを開く',
        }),
      );
      return true;

    case 'task_complete_menu':
      await replyTaskCarouselForActor(ctx, ['complete_assignee', 'delay_menu']);
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

    // リッチメニュー「問題報告」: 新規報告 / 問題一覧 の選択メニュー
    case 'task_problem_menu':
      await replyFlex(
        ctx,
        '問題報告メニュー',
        buildProblemMenuBubble({
          liffUrl: liffWith(ctx.liffUrl, 'task_problem'),
        }),
      );
      return true;

    // タスクカードの「⚠️ 問題報告」ボタン: 該当タスクに紐づく LIFF フォームへ
    case 'task_problem_open':
      await replyFlex(
        ctx,
        '問題報告フォーム',
        buildLiffOpenBubble({
          title: '⚠️ 問題報告フォーム',
          description: 'お疲れさまです🙏\n下のボタンからフォームを開いてください',
          liffUrl: liffWith(
            ctx.liffUrl,
            'task_problem',
            params.get('id') ? { taskId: params.get('id') as string } : undefined,
          ),
          buttonLabel: 'フォームを開く',
        }),
      );
      return true;

    // 問題一覧 (admin/staff 全員閲覧可)
    case 'problems_list_open': {
      const items = await listOpenProblems(ctx.db);
      const enriched: ProblemListItem[] = [];
      for (const t of items) {
        const [a, p] = await Promise.all([
          getFriendById(ctx.db, t.assignee_friend_id),
          getLatestProblemReport(ctx.db, t.id),
        ]);
        const reporter = p?.reporterFriendId ? await getFriendById(ctx.db, p.reporterFriendId) : null;
        enriched.push({
          task: t,
          assigneeName: a?.display_name ?? null,
          problemText: p?.text ?? '',
          severity: p?.severity ?? 'medium',
          reporterName: reporter?.display_name ?? null,
        });
      }
      await replyFlex(
        ctx,
        `問題一覧 (${items.length}件)`,
        buildProblemCarousel(enriched),
      );
      return true;
    }

    // 問題解決マーク (担当者側)
    case 'problem_resolve_assignee': {
      const task = await assertAssigneeOrAdmin(ctx, params.get('id'));
      if (!task) return true;
      const result = await markProblemResolvedByAssignee(ctx.db, task.id, ctx.friend.id);
      const updated = result.task ?? task;
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      const requester = await getFriendById(ctx.db, task.requester_friend_id);
      await replyText(
        ctx,
        result.finalized
          ? '✅ 双方が解決マークしたため、問題を解決済みにしました'
          : result.alreadyMarked
            ? '既に担当者として解決マーク済みです (依頼者の確認待ち)'
            : '🟢 担当者として解決マークしました (依頼者の確認待ち)',
      );
      // push 通知 (相手側)
      try {
        if (result.finalized) {
          // 双方マーク → 双方に「問題が解決されました」push (自分以外)
          const targets = [assignee, requester].filter(
            (f): f is Friend =>
              !!f && !!f.line_user_id && f.line_user_id !== ctx.friend.line_user_id,
          );
          await Promise.all(
            targets.map((f) =>
              ctx.lineClient
                .pushFlexMessage(
                  f.line_user_id!,
                  `「${task.title}」の問題が解決されました`,
                  buildTaskCard({
                    task: updated,
                    assigneeName: assignee?.display_name ?? null,
                    actions: ['complete_assignee', 'delay_menu'],
                  }) as never,
                )
                .catch((err) => console.error('problem finalized push failed', { friendId: f.id, err })),
            ),
          );
        } else if (!result.alreadyMarked) {
          // 担当者初回マーク → 依頼者に「解決確認をお願いします」
          if (requester && requester.line_user_id && requester.line_user_id !== ctx.friend.line_user_id) {
            await ctx.lineClient.pushFlexMessage(
              requester.line_user_id,
              `「${task.title}」の問題を担当者が解決マークしました`,
              buildTaskCard({
                task: updated,
                assigneeName: assignee?.display_name ?? null,
                actions: [],
              }) as never,
            );
          }
        }
      } catch (err) {
        console.error('problem resolve push (assignee) failed', err);
      }
      return true;
    }

    // 問題解決マーク (依頼者側)
    case 'problem_resolve_requester': {
      const task = await assertRequesterOrAdmin(ctx, params.get('id'));
      if (!task) return true;
      const result = await markProblemResolvedByRequester(ctx.db, task.id, ctx.friend.id);
      const updated = result.task ?? task;
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      const requester = await getFriendById(ctx.db, task.requester_friend_id);
      await replyText(
        ctx,
        result.finalized
          ? '✅ 双方が解決マークしたため、問題を解決済みにしました'
          : result.alreadyMarked
            ? '既に依頼者として解決マーク済みです (担当者の確認待ち)'
            : '🟢 依頼者として解決マークしました (担当者の確認待ち)',
      );
      try {
        if (result.finalized) {
          const targets = [assignee, requester].filter(
            (f): f is Friend =>
              !!f && !!f.line_user_id && f.line_user_id !== ctx.friend.line_user_id,
          );
          await Promise.all(
            targets.map((f) =>
              ctx.lineClient
                .pushFlexMessage(
                  f.line_user_id!,
                  `「${task.title}」の問題が解決されました`,
                  buildTaskCard({
                    task: updated,
                    assigneeName: assignee?.display_name ?? null,
                    actions: ['complete_assignee', 'delay_menu'],
                  }) as never,
                )
                .catch((err) => console.error('problem finalized push failed', { friendId: f.id, err })),
            ),
          );
        } else if (!result.alreadyMarked) {
          if (assignee && assignee.line_user_id && assignee.line_user_id !== ctx.friend.line_user_id) {
            await ctx.lineClient.pushFlexMessage(
              assignee.line_user_id,
              `「${task.title}」の問題を依頼者が解決マークしました`,
              buildTaskCard({
                task: updated,
                assigneeName: assignee.display_name ?? null,
                actions: [],
              }) as never,
            );
          }
        }
      } catch (err) {
        console.error('problem resolve push (requester) failed', err);
      }
      return true;
    }

    case 'task_list_mine':
      await replyTaskCarouselForActor(ctx, ['complete_assignee', 'delay_menu', 'detail']);
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
      await replyFlex(
        ctx,
        '依頼・提案フォーム',
        buildLiffOpenBubble({
          title: '💡 依頼・提案フォーム',
          description: 'お疲れさまです🙏\n下のボタンからフォームを開いてください',
          liffUrl: liffWith(ctx.liffUrl, 'request_or_propose'),
          buttonLabel: 'フォームを開く',
        }),
      );
      return true;

    // ── 個別タスクのアクション ────────────────────────────────────────────

    case 'task_start': {
      // 着手は担当者本人 + admin (依頼者は着手しない)
      const task = await assertAssigneeOrAdmin(ctx, params.get('id'));
      if (!task) return true;
      const updated = await markTaskStarted(ctx.db, task.id, ctx.friend.id);
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      await replyFlex(
        ctx,
        '着手を記録しました',
        buildTaskCard({
          task: updated ?? task,
          assigneeName: assignee?.display_name ?? null,
          actions: ['complete_assignee', 'delay_menu', 'problem'],
        }),
      );
      // 着手では push 通知を送らない (要件: 着手は通知がいかない仕様)
      return true;
    }

    // 旧 task_complete / task_complete_confirm: 後方互換のため残置 (assignee 用 alias)
    case 'task_complete':
    case 'task_complete_confirm':
    case 'task_complete_assignee': {
      // 担当者本人 + admin が押せる (依頼者は押せない)
      const task = await assertAssigneeOrAdmin(ctx, params.get('id'));
      if (!task) return true;
      const before = task;
      const result = await markCompletionByAssignee(ctx.db, task.id, ctx.friend.id);
      const updated = result.task ?? task;
      // 期日内に押せたなら "申告できた" カウンタ++ (初回マーク時のみ)
      if (!result.alreadyMarked && isTimeBefore(jstNow(), before.due_at)) {
        await incrementStaffMetric(ctx.db, ctx.friend.id, 'reported_on_time_count');
      }
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      const requester = await getFriendById(ctx.db, task.requester_friend_id);
      // 自分宛 reply: 状態を反映したカード (status=done なら ボタンなし、片側完了なら 待ちラベル)
      await replyFlex(
        ctx,
        result.finalized ? '完了を確定しました' : '完了報告を記録しました (依頼者の承認待ち)',
        buildTaskCard({
          task: updated,
          assigneeName: assignee?.display_name ?? null,
          actions: result.finalized ? [] : [],
        }),
      );
      // push 通知
      try {
        if (result.finalized) {
          // 双方マーク完了 → 双方に「完了確定」push (自分以外)
          const elapsed = Math.max(
            1,
            Math.ceil((Date.now() - new Date(task.created_at).getTime()) / (24 * 60 * 60_000)),
          );
          const card = buildCompletionNoticeCard(updated, assignee?.display_name ?? null, elapsed);
          const altText = `「${task.title}」が完了しました`;
          const targets = [assignee, requester].filter(
            (f): f is Friend =>
              !!f && !!f.line_user_id && f.line_user_id !== ctx.friend.line_user_id,
          );
          await Promise.all(
            targets.map((f) =>
              ctx.lineClient
                .pushFlexMessage(f.line_user_id!, altText, card as never)
                .catch((err) => console.error('completion final push item failed', { friendId: f.id, err })),
            ),
          );
        } else if (!result.alreadyMarked) {
          // 担当者初回マーク → 依頼者に「完了承認をお願いします」
          if (requester && requester.line_user_id && requester.line_user_id !== ctx.friend.line_user_id) {
            await ctx.lineClient.pushFlexMessage(
              requester.line_user_id,
              `「${task.title}」の完了承認をお願いします`,
              buildCompletionApprovalCard({
                task: updated,
                assigneeName: assignee?.display_name ?? null,
                requesterName: requester.display_name ?? null,
                kind: 'assignee_first',
              }) as never,
            );
          }
        }
      } catch (err) {
        console.error('completion push failed', err);
      }
      return true;
    }

    case 'task_complete_requester': {
      // 依頼者本人 + admin が押せる
      const task = await assertRequesterOrAdmin(ctx, params.get('id'));
      if (!task) return true;
      const result = await markCompletionByRequester(ctx.db, task.id, ctx.friend.id);
      const updated = result.task ?? task;
      const assignee = await getFriendById(ctx.db, task.assignee_friend_id);
      const requester = await getFriendById(ctx.db, task.requester_friend_id);
      await replyFlex(
        ctx,
        result.finalized ? '完了を確定しました' : '完了承認を記録しました (担当者の完了報告待ち)',
        buildTaskCard({
          task: updated,
          assigneeName: assignee?.display_name ?? null,
          actions: [],
        }),
      );
      try {
        if (result.finalized) {
          const elapsed = Math.max(
            1,
            Math.ceil((Date.now() - new Date(task.created_at).getTime()) / (24 * 60 * 60_000)),
          );
          const card = buildCompletionNoticeCard(updated, assignee?.display_name ?? null, elapsed);
          const altText = `「${task.title}」が完了しました`;
          const targets = [assignee, requester].filter(
            (f): f is Friend =>
              !!f && !!f.line_user_id && f.line_user_id !== ctx.friend.line_user_id,
          );
          await Promise.all(
            targets.map((f) =>
              ctx.lineClient
                .pushFlexMessage(f.line_user_id!, altText, card as never)
                .catch((err) => console.error('completion final push item failed', { friendId: f.id, err })),
            ),
          );
        } else if (!result.alreadyMarked) {
          // 依頼者初回マーク → 担当者に「事前承認されました」
          if (assignee && assignee.line_user_id && assignee.line_user_id !== ctx.friend.line_user_id) {
            await ctx.lineClient.pushFlexMessage(
              assignee.line_user_id,
              `「${task.title}」が事前承認されました。完了報告で確定します`,
              buildCompletionApprovalCard({
                task: updated,
                assigneeName: assignee.display_name ?? null,
                requesterName: requester?.display_name ?? null,
                kind: 'requester_first',
              }) as never,
            );
          }
        }
      } catch (err) {
        console.error('completion push failed', err);
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
          actions: ['complete_assignee', 'delay_menu', 'problem'],
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
          showDescription: true,
        }),
      );
      return true;
    }

    // ── 新規スタッフオンボーディング (申請 / 承認 / 却下) ─────────────────────

    case 'staff_apply': {
      // 既に admin/staff の場合はスキップ
      const existingTags = await listFriendTags(ctx.db, ctx.friend.id);
      if (existingTags.includes('role:admin') || existingTags.includes('role:staff')) {
        await replyText(ctx, '既に登録済みです。リッチメニューからご利用ください。');
        return true;
      }
      // 既に pending:staff なら申請の二重送信を防ぐ
      if (existingTags.includes('pending:staff')) {
        await replyText(ctx, '既に申請を受け付けています。承認をお待ちください🙏');
        return true;
      }
      await addFriendTag(ctx.db, ctx.friend.id, TAG_PENDING_STAFF_ID);
      // 申請者に reply
      await replyText(ctx, '📝 申請を受け付けました。\n管理者の承認をお待ちください🙏');
      // admin 全員に push
      const admins = await listAdminFriends(ctx.db);
      const card = buildStaffApplicationNoticeCard({
        applicantDisplayName: ctx.friend.display_name ?? null,
        applicantFriendId: ctx.friend.id,
      });
      const altText = `📝 新規スタッフ登録 申請: ${ctx.friend.display_name ?? '(名前なし)'}`;
      await Promise.all(
        admins
          .filter((a) => a.line_user_id && a.id !== ctx.friend.id)
          .map((a) =>
            ctx.lineClient
              .pushFlexMessage(a.line_user_id!, altText, card as never)
              .catch((err) => console.error('staff_apply admin push failed', { adminId: a.id, err })),
          ),
      );
      return true;
    }

    case 'staff_approve': // legacy: staff role のみ、type は付けない (broadcast/lazy で本人が選ぶ)
    case 'staff_approve_staff_employee':
    case 'staff_approve_staff_contractor':
    case 'staff_approve_admin': {
      // admin のみ実行可
      const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
      if (!isAdmin) {
        await replyText(ctx, 'この操作は管理者のみ可能です。');
        return true;
      }
      const applicantId = params.get('id');
      if (!applicantId) {
        await replyText(ctx, '申請者IDが見つかりません。');
        return true;
      }
      const applicant = await getFriendById(ctx.db, applicantId);
      if (!applicant) {
        await replyText(ctx, '申請者が見つかりませんでした。');
        return true;
      }
      const targetRole: 'staff' | 'admin' = action === 'staff_approve_admin' ? 'admin' : 'staff';
      const targetType: 'employee' | 'contractor' | null =
        action === 'staff_approve_admin'
          ? 'employee' // admin は社員扱い固定
          : action === 'staff_approve_staff_employee'
            ? 'employee'
            : action === 'staff_approve_staff_contractor'
              ? 'contractor'
              : null; // legacy `staff_approve` — type 未付与
      const roleTagId = targetRole === 'admin' ? TAG_ROLE_ADMIN_ID : TAG_ROLE_STAFF_ID;
      const typeTagId =
        targetType === 'employee'
          ? TAG_TYPE_EMPLOYEE_ID
          : targetType === 'contractor'
            ? TAG_TYPE_CONTRACTOR_ID
            : null;
      const richMenuId = targetRole === 'admin' ? RICH_MENU_ADMIN_ID : RICH_MENU_STAFF_ID;

      // pending:staff を外して、role タグを付与
      await removeFriendTag(ctx.db, applicantId, TAG_PENDING_STAFF_ID).catch(() => {});
      await addFriendTag(ctx.db, applicantId, roleTagId);
      // 区分 (type) タグ: 排他で付与 (反対側があれば外す)
      if (typeTagId) {
        const otherTypeId =
          typeTagId === TAG_TYPE_EMPLOYEE_ID ? TAG_TYPE_CONTRACTOR_ID : TAG_TYPE_EMPLOYEE_ID;
        await removeFriendTag(ctx.db, applicantId, otherTypeId).catch(() => {});
        await addFriendTag(ctx.db, applicantId, typeTagId);
      }
      // Rich Menu リンク
      if (applicant.line_user_id) {
        try {
          await ctx.lineClient.linkRichMenuToUser(applicant.line_user_id, richMenuId);
        } catch (err) {
          console.error('linkRichMenuToUser failed', { applicantId, err });
        }
      }
      const typeLabel =
        targetType === 'employee' ? '社員' : targetType === 'contractor' ? '委託' : '区分未設定';
      await replyText(
        ctx,
        `✅ ${applicant.display_name ?? '申請者'} さんを ${targetRole}・${typeLabel} として承認しました`,
      );
      // 申請者に通知
      if (applicant.line_user_id) {
        try {
          await ctx.lineClient.pushFlexMessage(
            applicant.line_user_id,
            `🎉 ${targetRole === 'admin' ? '管理者' : 'スタッフ'}として登録されました`,
            buildApplicationApprovedCard({ role: targetRole }) as never,
          );
        } catch (err) {
          console.error('approval notice push failed', { applicantId, err });
        }
      }
      return true;
    }

    case 'staff_reject': {
      const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
      if (!isAdmin) {
        await replyText(ctx, 'この操作は管理者のみ可能です。');
        return true;
      }
      const applicantId = params.get('id');
      if (!applicantId) {
        await replyText(ctx, '申請者IDが見つかりません。');
        return true;
      }
      const applicant = await getFriendById(ctx.db, applicantId);
      if (!applicant) {
        await replyText(ctx, '申請者が見つかりませんでした。');
        return true;
      }
      await removeFriendTag(ctx.db, applicantId, TAG_PENDING_STAFF_ID).catch(() => {});
      await replyText(ctx, `❌ ${applicant.display_name ?? '申請者'} さんの申請を却下しました`);
      if (applicant.line_user_id) {
        try {
          await ctx.lineClient.pushFlexMessage(
            applicant.line_user_id,
            'ご連絡',
            buildApplicationRejectedCard() as never,
          );
        } catch (err) {
          console.error('rejection notice push failed', { applicantId, err });
        }
      }
      return true;
    }

    // リッチメニュー「プロジェクト一覧」: LIFF projects ページを開く Flex を返信
    case 'projects_open':
      await replyFlex(
        ctx,
        'プロジェクト一覧',
        buildLiffOpenBubble({
          title: '📋 プロジェクト一覧',
          description: 'タスクの俯瞰・完了一覧・進行中などをタブ切替で確認できます',
          liffUrl: liffWith(ctx.liffUrl, 'projects'),
          buttonLabel: 'プロジェクト一覧を開く',
        }),
      );
      return true;

    // 社員/委託 区分 選択カードの「社員 / 委託 として登録」ボタン
    case 'set_member_type': {
      const value = params.get('value');
      if (value !== 'employee' && value !== 'contractor') {
        await replyText(ctx, '区分の値が不正です。');
        return true;
      }
      const typeTagId = value === 'employee' ? TAG_TYPE_EMPLOYEE_ID : TAG_TYPE_CONTRACTOR_ID;
      const otherId = value === 'employee' ? TAG_TYPE_CONTRACTOR_ID : TAG_TYPE_EMPLOYEE_ID;
      await removeFriendTag(ctx.db, ctx.friend.id, otherId).catch(() => {});
      await addFriendTag(ctx.db, ctx.friend.id, typeTagId);
      await replyText(
        ctx,
        value === 'employee'
          ? '✅ 社員 として登録しました。毎朝 9:30 に進捗報告のリマインドが届きます🙏'
          : '✅ 委託 として登録しました。タスク期日に応じた進捗報告のみお願いします🙏',
      );
      return true;
    }

    // admin リッチメニュー「再登録カードを全員に送る」: broadcast endpoint をサーバ内で叩く
    case 'request_member_type_resend_all': {
      const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
      if (!isAdmin) {
        await replyText(ctx, 'この操作は管理者のみ可能です。');
        return true;
      }
      // broadcast 対象を直接 SELECT して push (route の処理を内製化、HTTP 経由を避ける)
      const targets = await ctx.db
        .prepare(
          `SELECT f.* FROM friends f
           WHERE f.is_following = 1
             AND EXISTS (
               SELECT 1 FROM friend_tags ft
               INNER JOIN tags t ON t.id = ft.tag_id
               WHERE ft.friend_id = f.id AND t.name IN ('role:admin','role:staff')
             )
             AND NOT EXISTS (
               SELECT 1 FROM friend_tags ft
               INNER JOIN tags t ON t.id = ft.tag_id
               WHERE ft.friend_id = f.id AND t.name IN ('type:employee','type:contractor')
             )`,
        )
        .all<Friend>();
      let sent = 0;
      const { buildMemberTypeChoiceCard } = await import('./task-flex.js');
      for (const f of targets.results) {
        if (!f.line_user_id) continue;
        try {
          const card = buildMemberTypeChoiceCard({
            friendDisplayName: f.display_name ?? null,
            reason: 'broadcast',
          });
          await ctx.lineClient.pushFlexMessage(
            f.line_user_id,
            '👋 社員 / 委託 区分の登録',
            card as never,
          );
          sent++;
        } catch (err) {
          console.error('member_type broadcast push failed', { friendId: f.id, err });
        }
      }
      await replyText(
        ctx,
        `📨 区分未登録 ${targets.results.length} 名にカードを送信 (成功 ${sent} 件)`,
      );
      return true;
    }
  }

  return false;
}

// ── スタッフオンボーディング用ヘルパ ────────────────────────────────────────

async function listFriendTags(db: D1Database, friendId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT t.name FROM friend_tags ft
       INNER JOIN tags t ON t.id = ft.tag_id
       WHERE ft.friend_id = ?`,
    )
    .bind(friendId)
    .all<{ name: string }>();
  return result.results.map((r) => r.name);
}

async function addFriendTag(db: D1Database, friendId: string, tagId: string): Promise<void> {
  // friend_tags は (friend_id, tag_id) で UNIQUE 想定。INSERT OR IGNORE で冪等性確保。
  await db
    .prepare(
      `INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, created_at)
       VALUES (?, ?, datetime('now'))`,
    )
    .bind(friendId, tagId)
    .run();
}

async function removeFriendTag(db: D1Database, friendId: string, tagId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?`)
    .bind(friendId, tagId)
    .run();
}

async function listAdminFriends(db: D1Database): Promise<Friend[]> {
  const result = await db
    .prepare(
      `SELECT f.* FROM friends f
       INNER JOIN friend_tags ft ON ft.friend_id = f.id
       INNER JOIN tags t ON t.id = ft.tag_id
       WHERE t.name = ? AND f.is_following = 1`,
    )
    .bind(ADMIN_TAG_NAME)
    .all<Friend>();
  return result.results;
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

/** 担当者本人 + admin のみ操作可 (着手・完了報告)。 */
async function assertAssigneeOrAdmin(
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
  const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
  if (!(isAssignee || isAdmin)) {
    await replyText(ctx, 'これは担当者用の操作です。');
    return null;
  }
  return task;
}

/** 依頼者本人 + admin のみ操作可 (完了承認)。 */
async function assertRequesterOrAdmin(
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
  const isRequester = task.requester_friend_id === ctx.friend.id;
  const isAdmin = await friendHasAdminRole(ctx.db, ctx.friend.id);
  if (!(isRequester || isAdmin)) {
    await replyText(ctx, 'これは依頼者用の操作です。');
    return null;
  }
  return task;
}

function liffWith(base: string, page: string, extras?: Record<string, string>): string {
  // hash フラグメント形式: https://liff.line.me/<LIFF_ID>#page=<page>&<extras>
  // クエリ形式 (?page=...) や path 形式 (/<page>) は一部端末・LINE バージョンで
  // 「Bad Request」を引き起こす事例があった。fragment はサーバーに送られないため
  // LINE 側のバリデーションを通過しやすい。client 側 (main.ts) は hash を読んで page 判定する。
  const cleanBase = base.replace(/#.*$/, '');
  const params = new URLSearchParams({ page });
  if (extras) for (const [k, v] of Object.entries(extras)) params.set(k, v);
  return `${cleanBase}#${params.toString()}`;
}

// 未使用ヘルパ抑制
void getFriendByLineUserId;
