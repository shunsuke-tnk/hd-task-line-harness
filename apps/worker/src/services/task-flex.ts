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
}

export type TaskCardAction =
  | 'start'
  | 'complete'
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
            { type: 'text', text: '担当', size: 'xs', color: '#888', flex: 1 },
            { type: 'text', text: assigneeName || '—', size: 'sm', color: '#333', flex: 4, wrap: true },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '期日', size: 'xs', color: '#888', flex: 1 },
            { type: 'text', text: due, size: 'sm', color: '#333', flex: 2 },
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
                  { type: 'text', text: '延期', size: 'xs', color: '#888', flex: 1 },
                  { type: 'text', text: `${task.postpone_count}回`, size: 'sm', color: '#F4511E', flex: 4 },
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
        { type: 'text', text: '対象のタスクはありません', size: 'sm', color: '#888', align: 'center' },
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
        { type: 'text', text: task.display_id, size: 'xs', color: '#888', align: 'end' },
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
            { type: 'text', text: '担当', size: 'xs', color: '#888', flex: 1 },
            { type: 'text', text: assigneeName || '—', size: 'sm', color: '#333', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '現期日', size: 'xs', color: '#888', flex: 1 },
            { type: 'text', text: formatDate(task.due_at), size: 'sm', color: '#333', flex: 4 },
          ],
        },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '何日延期しますか?', size: 'sm', color: '#555', margin: 'md' },
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
        { type: 'text', text: `${task.display_id} ${task.title}`, size: 'sm', color: '#555', wrap: true },
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
        { type: 'text', text: `${task.display_id} ${task.title}`, size: 'sm', color: '#555', wrap: true },
        { type: 'text', text: '取り消した番号は再利用されません。', size: 'xs', color: '#888' },
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
        { type: 'text', text: task.display_id, size: 'xs', color: '#888', align: 'end' },
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
            { type: 'text', text: '担当', size: 'xs', color: '#888', flex: 1 },
            { type: 'text', text: assigneeName || '—', size: 'sm', color: '#333', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: '期日', size: 'xs', color: '#888', flex: 1 },
            { type: 'text', text: due, size: 'sm', color: '#333', flex: 2 },
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
        { type: 'text', text: task.display_id, size: 'xs', color: '#888', align: 'end' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: task.title, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: `${assigneeName || '担当者'}が${durationDays}日で対応してくださいました`, size: 'sm', color: '#555', wrap: true },
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
      { type: 'text', text: '名前', size: 'xs', color: '#888', flex: 4, weight: 'bold' },
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
    ? [{ type: 'text' as const, text: 'まだ集計データがありません', size: 'sm' as const, color: '#888', align: 'center' as const }]
    : sorted.map((r) => ({
        type: 'box',
        layout: 'horizontal',
        spacing: 'xs',
        contents: [
          { type: 'text', text: r.displayName || '—', size: 'sm', color: '#333', flex: 4, wrap: true },
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
          color: '#888',
          wrap: true,
          margin: 'sm',
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
