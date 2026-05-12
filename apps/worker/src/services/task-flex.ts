// =============================================================================
// HD TaskBot — Flex Message Builders
// =============================================================================
// LINE Flex Message を生成するビルダー集。型は最小限で、LINE Messaging API
// (https://developers.line.biz/en/reference/messaging-api/#flex-message) の
// JSON 構造に直接渡せる形で出力する。
// =============================================================================

import type { Task } from '@line-crm/db';

/** YYYY/MM/DD (JST) で表示。 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  const jst = new Date(d.getTime() + 9 * 60 * 60_000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/** あと X 日 / 過ぎている。 */
function daysRemainingLabel(dueIso: string): { label: string; color: string } {
  const due = new Date(dueIso).getTime();
  const now = Date.now();
  const diffMs = due - now;
  const days = Math.ceil(diffMs / (24 * 60 * 60_000));
  if (diffMs < 0) {
    const overdueDays = Math.ceil(Math.abs(diffMs) / (24 * 60 * 60_000));
    return { label: `${overdueDays}日超過`, color: '#E53935' };
  }
  if (days === 0) return { label: '今日が期限', color: '#FB8C00' };
  if (days === 1) return { label: '明日が期限', color: '#FB8C00' };
  return { label: `あと${days}日`, color: '#388E3C' };
}

function statusBadge(status: string): { label: string; color: string } {
  switch (status) {
    case 'pending':
      return { label: '未着手', color: '#9E9E9E' };
    case 'in_progress':
      return { label: '着手中', color: '#1E88E5' };
    case 'delayed':
      return { label: '遅延', color: '#F4511E' };
    case 'problem':
      return { label: '問題報告', color: '#D32F2F' };
    case 'done':
      return { label: '完了', color: '#43A047' };
    case 'cancelled':
      return { label: '取消', color: '#616161' };
    default:
      return { label: status, color: '#9E9E9E' };
  }
}

// ── 1. タスクカード (1件) ────────────────────────────────────────────────────

export interface TaskCardOpts {
  task: Task;
  assigneeName: string | null;
  /** どのアクション群を表示するか */
  actions: TaskCardAction[];
  /** body にタスクの description (補足メモ) を表示するか。デフォルト false。
   *  - 担当者通知 (新規タスク push) と タスク詳細表示 で true にする想定。
   *  - リマインドや完了通知では情報過多を避けるため false。 */
  showDescription?: boolean;
}

export type TaskCardAction =
  | 'start'
  | 'complete' // 旧: 単発完了 (deprecated, 残置)
  | 'complete_assignee' // 担当者「完了報告」(2段階承認の片側)
  | 'complete_requester' // 依頼者「完了承認」(2段階承認のもう片側)
  | 'delay_menu'
  | 'problem'
  | 'cancel'
  | 'detail';

export function buildTaskCard(opts: TaskCardOpts): unknown {
  const { task, assigneeName } = opts;
  const due = formatDate(task.due_at);
  const remaining = daysRemainingLabel(task.due_at);
  const status = statusBadge(task.status);

  const buttons = opts.actions.map((a) => actionToButton(task, a));

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: task.display_id, weight: 'bold', size: 'sm', color: '#06C755', flex: 0 },
        { type: 'text', text: status.label, size: 'xs', color: status.color, align: 'end' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: task.title, weight: 'bold', size: 'md', wrap: true },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '担当', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: assigneeName || '—', size: 'sm', color: '#333333', flex: 4, wrap: true },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '期日', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: due, size: 'sm', color: '#333333', flex: 2 },
            { type: 'text', text: remaining.label, size: 'sm', color: remaining.color, flex: 2, align: 'end' },
          ],
        },
        ...(task.postpone_count > 0
          ? [
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: '延期', size: 'xs', color: '#888888', flex: 1 },
                  { type: 'text', text: `${task.postpone_count}回`, size: 'sm', color: '#F4511E', flex: 4 },
                ],
              },
            ]
          : []),
        ...(opts.showDescription && task.description?.trim()
          ? [
              { type: 'separator', margin: 'sm' },
              {
                type: 'box',
                layout: 'vertical',
                spacing: 'xs',
                margin: 'sm',
                contents: [
                  { type: 'text', text: 'メモ', size: 'xs', color: '#888888' },
                  {
                    type: 'text',
                    text: task.description.trim(),
                    size: 'xs',
                    color: '#555555',
                    wrap: true,
                  },
                ],
              },
            ]
          : []),
        // 2段階承認 (片側マーク表示) — 完了承認状況
        ...(task.status !== 'done' && task.status !== 'cancelled' &&
          (task.completion_assignee_marked_at || task.completion_requester_marked_at)
          ? [
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                margin: 'sm',
                contents: [
                  { type: 'text', text: '完了承認', size: 'xs', color: '#888888', flex: 1 },
                  {
                    type: 'text',
                    text:
                      task.completion_assignee_marked_at && task.completion_requester_marked_at
                        ? '✅ 双方承認済み'
                        : task.completion_assignee_marked_at
                          ? '⏳ 担当者が完了報告 — 依頼者の承認待ち'
                          : '⏳ 依頼者が事前承認 — 担当者の完了報告待ち',
                    size: 'xs',
                    color: '#06C755',
                    flex: 4,
                    wrap: true,
                  },
                ],
              },
            ]
          : []),
        // 2段階承認 (片側マーク表示) — 問題解決状況
        ...(task.status === 'problem' &&
          (task.problem_resolved_assignee_at || task.problem_resolved_requester_at)
          ? [
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                margin: 'sm',
                contents: [
                  { type: 'text', text: '問題解決', size: 'xs', color: '#888888', flex: 1 },
                  {
                    type: 'text',
                    text:
                      task.problem_resolved_assignee_at && task.problem_resolved_requester_at
                        ? '✅ 双方解決マーク済み'
                        : task.problem_resolved_assignee_at
                          ? '⏳ 担当者が解決マーク — 依頼者の確認待ち'
                          : '⏳ 依頼者が解決マーク — 担当者の確認待ち',
                    size: 'xs',
                    color: '#7CB342',
                    flex: 4,
                    wrap: true,
                  },
                ],
              },
            ]
          : []),
      ],
    },
    footer: buttons.length
      ? {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: buttons,
        }
      : undefined,
  };
}

function actionToButton(task: Task, action: TaskCardAction): unknown {
  switch (action) {
    case 'start':
      return {
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: '#06C755',
        action: {
          type: 'postback',
          label: '▶︎ 着手します',
          data: `action=task_start&id=${task.id}`,
          displayText: `「${task.title}」着手します`,
        },
      };
    case 'complete':
      return {
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: '#06C755',
        action: {
          type: 'postback',
          label: '🎉 完了報告',
          data: `action=task_complete&id=${task.id}`,
          displayText: `「${task.title}」完了報告`,
        },
      };
    case 'complete_assignee':
      return {
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: '#06C755',
        action: {
          type: 'postback',
          label: '🎉 完了報告',
          data: `action=task_complete_assignee&id=${task.id}`,
          displayText: `「${task.title}」完了報告`,
        },
      };
    case 'complete_requester':
      return {
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: '#06C755',
        action: {
          type: 'postback',
          label: '✅ 完了を承認',
          data: `action=task_complete_requester&id=${task.id}`,
          displayText: `「${task.title}」完了承認`,
        },
      };
    case 'delay_menu':
      return {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: '⏰ 遅延報告',
          data: `action=task_delay_menu&id=${task.id}`,
          displayText: `「${task.title}」遅延報告`,
        },
      };
    case 'problem':
      return {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: '⚠️ 問題報告',
          data: `action=task_problem_open&id=${task.id}`,
          displayText: `「${task.title}」問題報告`,
        },
      };
    case 'cancel':
      return {
        type: 'button',
        style: 'link',
        height: 'sm',
        action: {
          type: 'postback',
          label: '❌ 取り消し',
          data: `action=task_cancel_confirm&id=${task.id}`,
          displayText: `「${task.title}」取消の確認`,
        },
      };
    case 'detail':
      return {
        type: 'button',
        style: 'link',
        height: 'sm',
        action: {
          type: 'postback',
          label: '📋 詳細',
          data: `action=task_detail&id=${task.id}`,
          displayText: `「${task.title}」詳細`,
        },
      };
  }
}

// ── 2. カルーセル (タスク一覧) ──────────────────────────────────────────────

export function buildTaskCarousel(items: Array<{ task: Task; assigneeName: string | null; actions: TaskCardAction[] }>): unknown {
  if (items.length === 0) return buildEmptyTaskBubble();
  const bubbles = items.slice(0, 10).map((it) => buildTaskCard(it));
  return {
    type: 'carousel',
    contents: bubbles,
  };
}

export function buildEmptyTaskBubble(): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '対象のタスクはありません', size: 'sm', color: '#888888', align: 'center' },
      ],
    },
  };
}

// ── 3. 遅延延期 +N日メニュー ────────────────────────────────────────────────

export function buildDelayMenuCard(task: Task, assigneeName: string | null): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: '⏰ 遅延報告', weight: 'bold', size: 'sm', color: '#F4511E' },
        { type: 'text', text: task.display_id, size: 'xs', color: '#888888', align: 'end' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: task.title, weight: 'bold', size: 'md', wrap: true },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '担当', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: assigneeName || '—', size: 'sm', color: '#333333', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '現期日', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: formatDate(task.due_at), size: 'sm', color: '#333333', flex: 4 },
          ],
        },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '何日延期しますか?', size: 'sm', color: '#555555', margin: 'md' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        delayButton(task, 1),
        delayButton(task, 2),
        delayButton(task, 3),
      ],
    },
  };
}

function delayButton(task: Task, days: number): unknown {
  const newDue = new Date(new Date(task.due_at).getTime() + days * 24 * 60 * 60_000);
  return {
    type: 'button',
    style: 'primary',
    color: '#F4511E',
    height: 'sm',
    action: {
      type: 'postback',
      label: `+${days}日 (${formatDate(newDue.toISOString())})`,
      data: `action=task_postpone&id=${task.id}&days=${days}`,
      displayText: `「${task.title}」を${days}日延期`,
    },
  };
}

// ── 4. 完了確認 confirm ────────────────────────────────────────────────────

export function buildConfirmComplete(task: Task): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '完了として記録しますか?', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: `${task.display_id} ${task.title}`, size: 'sm', color: '#555555', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          flex: 1,
          action: { type: 'postback', label: 'キャンセル', data: `action=noop`, displayText: 'キャンセル' },
        },
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          flex: 2,
          action: {
            type: 'postback',
            label: 'はい完了',
            data: `action=task_complete_confirm&id=${task.id}`,
            displayText: `「${task.title}」完了`,
          },
        },
      ],
    },
  };
}

// ── 5. 取り消し確認 ────────────────────────────────────────────────────────

export function buildConfirmCancel(task: Task): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'タスクを取り消しますか?', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: `${task.display_id} ${task.title}`, size: 'sm', color: '#555555', wrap: true },
        { type: 'text', text: '取り消した番号は再利用されません。', size: 'xs', color: '#888888' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          flex: 1,
          action: { type: 'postback', label: 'やめる', data: `action=noop`, displayText: 'やめる' },
        },
        {
          type: 'button',
          style: 'primary',
          color: '#D32F2F',
          height: 'sm',
          flex: 2,
          action: {
            type: 'postback',
            label: 'はい取り消す',
            data: `action=task_cancel_confirm_yes&id=${task.id}`,
            displayText: `「${task.title}」取消`,
          },
        },
      ],
    },
  };
}

// ── 6. リマインド (前日/当日/超過) ──────────────────────────────────────────

export function buildReminderCard(task: Task, assigneeName: string | null, kind: 'pre' | 'today' | 'overdue'): unknown {
  const titlePrefix = kind === 'pre' ? '🔔 明日が期限' : kind === 'today' ? '⏰ 本日が期限' : '🚨 期日を超過しています';
  const headerColor = kind === 'overdue' ? '#D32F2F' : kind === 'today' ? '#F4511E' : '#1E88E5';
  const due = formatDate(task.due_at);
  const remaining = daysRemainingLabel(task.due_at);

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: titlePrefix, weight: 'bold', size: 'sm', color: headerColor },
        { type: 'text', text: task.display_id, size: 'xs', color: '#888888', align: 'end' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: task.title, weight: 'bold', size: 'md', wrap: true },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '担当', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: assigneeName || '—', size: 'sm', color: '#333333', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '期日', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: due, size: 'sm', color: '#333333', flex: 2 },
            { type: 'text', text: remaining.label, size: 'sm', color: remaining.color, flex: 2, align: 'end' },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        actionToButton(task, 'complete'),
        actionToButton(task, 'delay_menu'),
        actionToButton(task, 'problem'),
      ],
    },
  };
}

// ── 7. 完了通知 (依頼者向け) ────────────────────────────────────────────────

export function buildCompletionNoticeCard(task: Task, assigneeName: string | null, durationDays: number): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: '🎉 完了の報告', weight: 'bold', size: 'sm', color: '#43A047' },
        { type: 'text', text: task.display_id, size: 'xs', color: '#888888', align: 'end' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: task.title, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: `${assigneeName || '担当者'}が${durationDays}日で対応してくださいました`, size: 'sm', color: '#555555', wrap: true },
      ],
    },
  };
}

// ── 8. メトリクス Bubble (遅延カウント) ────────────────────────────────────

export interface MetricsBubbleRow {
  displayName: string | null;
  noReportCount: number;
  reportedOnTimeCount: number;
  delayReportCount: number;
}

export function buildMetricsBubble(rows: MetricsBubbleRow[], title = '📊 タスク報告状況'): unknown {
  const headerRow = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'xs',
    contents: [
      { type: 'text', text: '名前', size: 'xs', color: '#888888', flex: 4, weight: 'bold' },
      { type: 'text', text: '健全', size: 'xs', color: '#43A047', flex: 2, align: 'end', weight: 'bold' },
      { type: 'text', text: '遅延', size: 'xs', color: '#F4511E', flex: 2, align: 'end', weight: 'bold' },
      { type: 'text', text: '漏れ', size: 'xs', color: '#D32F2F', flex: 2, align: 'end', weight: 'bold' },
    ],
  };
  const sorted = [...rows].sort((a, b) => {
    if (b.noReportCount !== a.noReportCount) return b.noReportCount - a.noReportCount;
    return b.reportedOnTimeCount - a.reportedOnTimeCount;
  });
  const dataRows = sorted.length === 0
    ? [{ type: 'text' as const, text: 'まだ集計データがありません', size: 'sm' as const, color: '#888888', align: 'center' as const }]
    : sorted.map((r) => ({
        type: 'box',
        layout: 'horizontal',
        spacing: 'xs',
        contents: [
          { type: 'text', text: r.displayName || '—', size: 'sm', color: '#333333', flex: 4, wrap: true },
          { type: 'text', text: String(r.reportedOnTimeCount), size: 'sm', color: '#43A047', flex: 2, align: 'end' },
          { type: 'text', text: String(r.delayReportCount), size: 'sm', color: '#F4511E', flex: 2, align: 'end' },
          { type: 'text', text: String(r.noReportCount), size: 'sm', color: '#D32F2F', flex: 2, align: 'end' },
        ],
      }));

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [{ type: 'text', text: title, weight: 'bold', size: 'sm', color: '#06C755' }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        headerRow,
        { type: 'separator', margin: 'sm' },
        ...dataRows,
        { type: 'separator', margin: 'sm' },
        {
          type: 'text',
          text: '遅延があっても申告できていれば健全です。',
          size: 'xxs',
          color: '#888888',
          wrap: true,
          margin: 'sm',
        },
      ],
    },
  };
}

// ── 8a. 完了承認カード (担当者の完了報告 → 依頼者に push) ────────────────────
// 担当者が「完了報告」を押した直後に依頼者へ送る。
// 「承認」ボタンを押すと完了が確定する。
// 逆方向 (依頼者が先に「完了承認」を押した場合) は kind='requester_first' で
// 担当者へ「事前承認されています。完了報告で確定します」と通知する。

export function buildCompletionApprovalCard(opts: {
  task: Task;
  assigneeName: string | null;
  requesterName: string | null;
  kind: 'assignee_first' | 'requester_first';
}): unknown {
  const due = formatDate(opts.task.due_at);
  const isAssigneeFirst = opts.kind === 'assignee_first';
  const headline = isAssigneeFirst
    ? `🎉 ${opts.assigneeName ?? '担当者'}さんが完了報告しました`
    : `✅ ${opts.requesterName ?? '依頼者'}さんが事前承認しました`;
  const guideLine = isAssigneeFirst
    ? '内容を確認のうえ「完了を承認」を押してください。'
    : '担当者として完了したら「完了報告」を押してください。';
  const buttonAction = isAssigneeFirst
    ? {
        type: 'postback' as const,
        label: '✅ 完了を承認',
        data: `action=task_complete_requester&id=${opts.task.id}`,
        displayText: `「${opts.task.title}」完了承認`,
      }
    : {
        type: 'postback' as const,
        label: '🎉 完了報告',
        data: `action=task_complete_assignee&id=${opts.task.id}`,
        displayText: `「${opts.task.title}」完了報告`,
      };
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: headline, weight: 'bold', size: 'sm', color: '#06C755', wrap: true, flex: 5 },
        { type: 'text', text: opts.task.display_id, size: 'xs', color: '#888888', align: 'end', flex: 2 },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: opts.task.title, weight: 'bold', size: 'md', wrap: true },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '担当', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: opts.assigneeName ?? '—', size: 'sm', color: '#333333', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '期日', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: due, size: 'sm', color: '#333333', flex: 4 },
          ],
        },
        { type: 'text', text: guideLine, size: 'xs', color: '#666666', wrap: true, margin: 'sm' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: buttonAction,
        },
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          action: {
            type: 'postback',
            label: '📋 タスク詳細',
            data: `action=task_detail&id=${opts.task.id}`,
            displayText: `「${opts.task.title}」詳細`,
          },
        },
      ],
    },
  };
}

// ── 8b. 問題報告 push 通知カード ────────────────────────────────────────────
// 担当者・依頼者・admin 宛に「問題が発生しました」と push する際に使用。

const SEVERITY_BADGE: Record<'low' | 'medium' | 'high', { label: string; color: string }> = {
  low: { label: '低', color: '#7CB342' },
  medium: { label: '中', color: '#F4511E' },
  high: { label: '高', color: '#D32F2F' },
};

export function buildProblemReportCard(opts: {
  task: Task;
  assigneeName: string | null;
  reporterName: string | null;
  text: string;
  severity: 'low' | 'medium' | 'high';
}): unknown {
  const sev = SEVERITY_BADGE[opts.severity];
  const due = formatDate(opts.task.due_at);
  const textPreview = opts.text.length > 200 ? opts.text.slice(0, 200) + '…' : opts.text;
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: '⚠️ 問題報告', weight: 'bold', size: 'sm', color: '#D32F2F' },
        { type: 'text', text: opts.task.display_id, size: 'xs', color: '#888888', align: 'end' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: opts.task.title, weight: 'bold', size: 'md', wrap: true },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '担当', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: opts.assigneeName || '—', size: 'sm', color: '#333333', flex: 4, wrap: true },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '報告者', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: opts.reporterName || '—', size: 'sm', color: '#333333', flex: 4, wrap: true },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '緊急度', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: sev.label, size: 'sm', color: sev.color, weight: 'bold', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '期日', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: due, size: 'sm', color: '#333333', flex: 4 },
          ],
        },
        { type: 'separator', margin: 'sm' },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          margin: 'sm',
          contents: [
            { type: 'text', text: '内容', size: 'xs', color: '#888888' },
            { type: 'text', text: textPreview, size: 'sm', color: '#333333', wrap: true },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          action: {
            type: 'postback',
            label: '📋 タスク詳細',
            data: `action=task_detail&id=${opts.task.id}`,
            displayText: `「${opts.task.title}」詳細`,
          },
        },
      ],
    },
  };
}

// ── 8c. 問題報告メニュー (一元化: 新規報告 / 問題一覧) ──────────────────────

export function buildProblemMenuBubble(opts: {
  liffUrl: string; // 「新規報告」用 LIFF URL (含 query/path/hash)
}): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: '⚠️ 問題報告', weight: 'bold', size: 'md', color: '#D32F2F' },
        {
          type: 'text',
          text: '新規に報告するか、進行中の問題一覧を確認できます',
          size: 'sm',
          color: '#666666',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#D32F2F',
          height: 'sm',
          action: {
            type: 'uri',
            label: '📝 新規報告',
            uri: opts.liffUrl,
          },
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'postback',
            label: '📋 問題一覧',
            data: 'action=problems_list_open',
            displayText: '問題一覧',
          },
        },
      ],
    },
  };
}

// ── 8d. 問題一覧 (Carousel + Bubble) ──────────────────────────────────────
// 各 Bubble: タスク (display_id+title) / 担当者 / 緊急度 / 内容 / 解決ステータス
// 解決ボタン: 「✅ 解決済み (担当者として)」 / 「✅ 解決済み (依頼者として)」
// admin は両方押せる、staff は閲覧のみ可だが押下は権限チェックでガード

export interface ProblemListItem {
  task: Task;
  assigneeName: string | null;
  problemText: string;
  severity: 'low' | 'medium' | 'high';
  reporterName: string | null;
}

export function buildProblemBubble(item: ProblemListItem): unknown {
  const sev = SEVERITY_BADGE[item.severity];
  const due = formatDate(item.task.due_at);
  const text =
    item.problemText.length > 140 ? item.problemText.slice(0, 140) + '…' : item.problemText;
  const assigneeMarked = !!item.task.problem_resolved_assignee_at;
  const requesterMarked = !!item.task.problem_resolved_requester_at;
  const resolveStatus =
    assigneeMarked && requesterMarked
      ? '✅ 双方解決マーク済み'
      : assigneeMarked
        ? '⏳ 担当者がマーク — 依頼者の確認待ち'
        : requesterMarked
          ? '⏳ 依頼者がマーク — 担当者の確認待ち'
          : '🔴 未解決';
  const resolveColor = assigneeMarked && requesterMarked ? '#7CB342' : '#D32F2F';
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: '⚠️ 問題', weight: 'bold', size: 'sm', color: '#D32F2F', flex: 0 },
        { type: 'text', text: item.task.display_id, size: 'xs', color: '#888888', align: 'end' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: item.task.title, weight: 'bold', size: 'sm', wrap: true },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '担当', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: item.assigneeName ?? '—', size: 'xs', color: '#333333', flex: 4, wrap: true },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '緊急', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: sev.label, size: 'xs', color: sev.color, weight: 'bold', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '期日', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: due, size: 'xs', color: '#333333', flex: 4 },
          ],
        },
        { type: 'separator', margin: 'sm' },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          margin: 'sm',
          contents: [
            { type: 'text', text: '内容', size: 'xs', color: '#888888' },
            { type: 'text', text: text, size: 'xs', color: '#333333', wrap: true },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          margin: 'sm',
          contents: [
            { type: 'text', text: '状態', size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: resolveStatus, size: 'xs', color: resolveColor, flex: 4, wrap: true },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: {
            type: 'postback',
            label: assigneeMarked ? '✓ 担当者マーク済' : '担当者として解決',
            data: `action=problem_resolve_assignee&id=${item.task.id}`,
            displayText: `「${item.task.title}」担当者として解決`,
          },
        },
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: {
            type: 'postback',
            label: requesterMarked ? '✓ 依頼者マーク済' : '依頼者として解決',
            data: `action=problem_resolve_requester&id=${item.task.id}`,
            displayText: `「${item.task.title}」依頼者として解決`,
          },
        },
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          action: {
            type: 'postback',
            label: '📋 タスク詳細',
            data: `action=task_detail&id=${item.task.id}`,
            displayText: `「${item.task.title}」詳細`,
          },
        },
      ],
    },
  };
}

export function buildProblemCarousel(items: ProblemListItem[]): unknown {
  if (items.length === 0) {
    return {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🎉 進行中の問題はありません',
            size: 'sm',
            color: '#06C755',
            align: 'center',
            weight: 'bold',
          },
        ],
      },
    };
  }
  return {
    type: 'carousel',
    contents: items.slice(0, 10).map((it) => buildProblemBubble(it)),
  };
}

// ── 8e. 新規スタッフ登録 (オンボーディング) ───────────────────────────────
// follow イベント直後に申請者へ送る挨拶カード。
// 「スタッフ登録を申請」ボタンを押すと postback (action=staff_apply) が走り、
// admin に承認依頼が push される。

export function buildWelcomeApplyCard(opts: { displayName: string | null }): unknown {
  const name = opts.displayName ?? 'お疲れさまです';
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: `👋 ${name} さん`, weight: 'bold', size: 'md', color: '#06C755', wrap: true },
        { type: 'text', text: 'HD TaskBot へようこそ', weight: 'bold', size: 'sm' },
        {
          type: 'text',
          text: 'タスク依頼・完了報告・遅延報告などを LINE 上で行えます。\nご利用には管理者の承認が必要です。下のボタンから登録申請をお願いします。',
          size: 'xs',
          color: '#666666',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: {
            type: 'postback',
            label: '📝 スタッフ登録を申請',
            data: 'action=staff_apply',
            displayText: 'スタッフ登録を申請します',
          },
        },
      ],
    },
  };
}

// admin 向け申請通知カード。
// 「✅ staff として承認」「👑 admin として承認」「❌ 却下」の3ボタンで判断。
export function buildStaffApplicationNoticeCard(opts: {
  applicantDisplayName: string | null;
  applicantFriendId: string;
}): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: '📝 新規スタッフ登録 申請', weight: 'bold', size: 'sm', color: '#FFA726' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '申請者', size: 'xs', color: '#888888', flex: 1 },
            {
              type: 'text',
              text: opts.applicantDisplayName ?? '(名前なし)',
              size: 'sm',
              color: '#333333',
              flex: 4,
              wrap: true,
              weight: 'bold',
            },
          ],
        },
        {
          type: 'text',
          text: 'ロールを選んで承認、または却下してください',
          size: 'xs',
          color: '#666666',
          margin: 'sm',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: {
            type: 'postback',
            label: '✅ staff として承認',
            data: `action=staff_approve&id=${opts.applicantFriendId}`,
            displayText: `${opts.applicantDisplayName ?? '申請者'} を staff 承認`,
          },
        },
        {
          type: 'button',
          style: 'primary',
          color: '#1E88E5',
          height: 'sm',
          action: {
            type: 'postback',
            label: '👑 admin として承認',
            data: `action=staff_approve_admin&id=${opts.applicantFriendId}`,
            displayText: `${opts.applicantDisplayName ?? '申請者'} を admin 承認`,
          },
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'postback',
            label: '❌ 却下',
            data: `action=staff_reject&id=${opts.applicantFriendId}`,
            displayText: `${opts.applicantDisplayName ?? '申請者'} を却下`,
          },
        },
      ],
    },
  };
}

// 承認結果カード (申請者向け push)。
export function buildApplicationApprovedCard(opts: { role: 'staff' | 'admin' }): unknown {
  const roleLabel = opts.role === 'admin' ? '管理者 (admin)' : 'スタッフ (staff)';
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🎉 登録完了', weight: 'bold', size: 'md', color: '#06C755' },
        {
          type: 'text',
          text: `${roleLabel} として登録されました。\nメニューが切り替わったので、リッチメニューからお試しください。`,
          size: 'sm',
          color: '#333333',
          wrap: true,
        },
      ],
    },
  };
}

// 却下結果カード (申請者向け push)。文面は穏やかに。
export function buildApplicationRejectedCard(): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'ご連絡', weight: 'bold', size: 'md', color: '#666666' },
        {
          type: 'text',
          text: '今回の登録申請は見送られました。詳細は管理者にお問い合わせください。',
          size: 'sm',
          color: '#666666',
          wrap: true,
        },
      ],
    },
  };
}

// ── 9. ラッパー: replyMessage 用 message オブジェクト ────────────────────────

export function flexMessage(altText: string, contents: unknown): { type: 'flex'; altText: string; contents: unknown } {
  return { type: 'flex', altText, contents };
}

export function textMessage(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

// ── 10. LIFF 起動用ボタン bubble ────────────────────────────────────────────
// テキストメッセージ内の URL タップが LINE クライアントによっては機能しない
// ケースがあるため、確実に tappable な uri action button で LIFF を開かせる。
export function buildLiffOpenBubble(opts: {
  title: string;
  description: string;
  liffUrl: string;
  buttonLabel: string;
}): unknown {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: opts.title, weight: 'bold', size: 'md', color: '#06C755' },
        { type: 'text', text: opts.description, size: 'sm', color: '#666666', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: {
            type: 'uri',
            label: opts.buttonLabel,
            uri: opts.liffUrl,
          },
        },
      ],
    },
  };
}
