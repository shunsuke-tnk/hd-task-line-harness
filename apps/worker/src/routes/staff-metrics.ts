import { Hono } from 'hono';
import { listStaffMetrics, getStaffMetrics, getFriendByLineUserId, getFriendById } from '@line-crm/db';
import type { Env } from '../index.js';

// =============================================================================
// HD TaskBot — Staff Metrics route
// =============================================================================
// 「遅延カウント」リッチメニューボタン押下時に表示する3カウンタ集計
//   * no_report_count           — 申告漏れ
//   * reported_on_time_count    — 申告できた (期日内に完了 or 遅延報告)
//   * delay_report_count        — 遅延申請 (押せていれば健全)
// =============================================================================

const staffMetrics = new Hono<Env>();

interface MetricsRow {
  friendId: string;
  displayName: string | null;
  noReportCount: number;
  reportedOnTimeCount: number;
  delayReportCount: number;
  updatedAt: string;
}

async function buildAllMetrics(db: D1Database): Promise<MetricsRow[]> {
  const rows = await listStaffMetrics(db);
  const out: MetricsRow[] = [];
  for (const r of rows) {
    const f = await getFriendById(db, r.friend_id);
    out.push({
      friendId: r.friend_id,
      displayName: f?.display_name ?? null,
      noReportCount: r.no_report_count,
      reportedOnTimeCount: r.reported_on_time_count,
      delayReportCount: r.delay_report_count,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

/** GET /api/staff-metrics — 全員のカウンタ一覧 (auth) */
staffMetrics.get('/api/staff-metrics', async (c) => {
  try {
    const data = await buildAllMetrics(c.env.DB);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/staff-metrics error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** GET /api/liff/staff-metrics?lineUserId=... — LIFF (public, lineUserId認証) */
staffMetrics.get('/api/liff/staff-metrics', async (c) => {
  try {
    const lineUserId = c.req.query('lineUserId');
    if (!lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    const me = await getFriendByLineUserId(c.env.DB, lineUserId);
    if (!me) return c.json({ success: false, error: 'not registered' }, 404);
    const all = await buildAllMetrics(c.env.DB);
    const myRow = await getStaffMetrics(c.env.DB, me.id);
    return c.json({
      success: true,
      data: { all, mine: { friendId: me.id, ...myRow } },
    });
  } catch (err) {
    console.error('GET /api/liff/staff-metrics error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staffMetrics };
