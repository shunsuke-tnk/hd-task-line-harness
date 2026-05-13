/**
 * HD TaskBot — Projects LIFF page
 *
 * URL: https://liff.line.me/<LIFF_ID>#page=projects[&tab=mine|all|done|active|metrics]
 *
 * タブ:
 *   📋 個人タスク (mine)        — 自分が assignee または requester
 *   🗂 プロジェクト一覧 (all)   — admin のみ全件 / それ以外は mine 相当
 *   ⏳ 進行中 (active)          — in_progress + delayed
 *   ✅ 完了 (done)              — status=done
 *   📊 報告状況 (metrics)       — admin のみ、全員のメトリクス表
 *
 * 各タスクをタップするとモーダルが開き、以下が可能:
 *   - 📝 進捗を書く (assignee/admin)
 *   - 🎉 完了報告 (assignee/admin) / ✅ 完了承認 (requester/admin)
 *   - ⏰ 遅延 +N日 (assignee/admin)
 *   - ⚠️ 問題報告 (LIFF task_problem へ遷移)
 *   - ✏️ 編集 (title/メモ/期日/優先度 — requester/admin)
 *   - ❌ 取消 (requester/admin)
 *
 * PC は表形式、モバイル (<768px) はカード表示で responsive。
 */

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string }>;
  isInClient(): boolean;
  closeWindow(): void;
};

type Tab = 'mine' | 'all' | 'active' | 'done' | 'metrics';

interface TaskRow {
  id: string;
  displayId: string;
  title: string;
  description: string | null;
  status: string;
  priority: 'high' | 'medium' | 'low';
  dueAt: string;
  completedAt: string | null;
  assigneeFriendId: string;
  requesterFriendId: string;
  assigneeName: string | null;
  requesterName: string | null;
  postponeCount: number;
  completionAssigneeMarkedAt?: string | null;
  completionRequesterMarkedAt?: string | null;
}

interface MetricsRow {
  friendId: string;
  displayName: string | null;
  noReportCount: number;
  reportedOnTimeCount: number;
  delayReportCount: number;
}

interface TasksResp {
  success: boolean;
  data: TaskRow[];
  me: { friendId: string; isAdmin: boolean };
  error?: string;
}

interface MetricsResp {
  success: boolean;
  data: MetricsRow[];
  me: { friendId: string; isAdmin: boolean };
  error?: string;
}

const CSS = `
  :root {
    --green: #06C755;
    --gray-50: #fafafa; --gray-100: #f2f2f2; --gray-300: #d0d0d0;
    --gray-500: #888888; --gray-700: #444444;
    --high: #E53935; --med: #FBC02D; --low: #9E9E9E;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Yu Gothic", sans-serif; background: var(--gray-50); color: var(--gray-700); }
  .pj-container { max-width: 960px; margin: 0 auto; padding: 16px 12px 64px; }
  .pj-header { font-size: 18px; font-weight: 700; color: var(--green); margin: 4px 0 12px; }
  .pj-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 12px; -webkit-overflow-scrolling: touch; }
  .pj-tab {
    flex: 0 0 auto; padding: 8px 14px; border: 1px solid var(--gray-300); border-radius: 999px;
    background: #fff; color: var(--gray-700); font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  .pj-tab.active { background: var(--green); color: #fff; border-color: var(--green); }
  .pj-empty { padding: 32px 16px; text-align: center; color: var(--gray-500); font-size: 14px; }
  .pj-loading { padding: 24px 16px; text-align: center; color: var(--gray-500); font-size: 13px; }
  .pj-card {
    background: #fff; border: 1px solid var(--gray-100); border-radius: 10px; padding: 12px 14px;
    margin-bottom: 8px; cursor: pointer;
  }
  .pj-card:active { background: #fafafa; }
  .pj-card-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .pj-pri { font-size: 13px; font-weight: 700; flex: 0 0 auto; }
  .pj-pri-high { color: var(--high); }
  .pj-pri-medium { color: var(--med); }
  .pj-pri-low { color: var(--low); }
  .pj-display-id { font-size: 11px; color: var(--green); font-weight: 700; flex: 0 0 auto; }
  .pj-title { font-size: 14px; font-weight: 600; color: var(--gray-700); }
  .pj-meta { font-size: 12px; color: var(--gray-500); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 12px; }
  .pj-status { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--gray-100); color: var(--gray-700); }
  .pj-status-pending { background: #f5f5f5; }
  .pj-status-in_progress { background: #E3F2FD; color: #1565C0; }
  .pj-status-delayed { background: #FFF3E0; color: #E65100; }
  .pj-status-problem { background: #FFEBEE; color: #C62828; }
  .pj-status-done { background: #E8F5E9; color: #2E7D32; }
  .pj-status-cancelled { background: #ECEFF1; color: #455A64; }

  .pj-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; }
  .pj-table th, .pj-table td { padding: 10px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--gray-100); }
  .pj-table tr { cursor: pointer; }
  .pj-table tr:hover td { background: #fafafa; }
  .pj-table th { background: var(--gray-50); font-weight: 600; color: var(--gray-700); font-size: 12px; cursor: default; }
  .pj-num { font-variant-numeric: tabular-nums; }

  /* モーダル */
  .pj-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 1000; display: flex; align-items: flex-end; justify-content: center; }
  .pj-modal { background: #fff; width: 100%; max-width: 640px; max-height: 90vh; overflow-y: auto;
    border-radius: 14px 14px 0 0; padding: 16px 16px 80px; }
  .pj-modal-head { display: flex; gap: 8px; align-items: flex-start; }
  .pj-modal-close { background: none; border: none; font-size: 20px; cursor: pointer; padding: 0 8px; color: var(--gray-500); flex: 0 0 auto; margin-left: auto; }
  .pj-modal-title { font-size: 16px; font-weight: 700; color: var(--gray-700); }
  .pj-modal-row { margin-top: 12px; }
  .pj-modal-label { font-size: 11px; color: var(--gray-500); font-weight: 600; margin-bottom: 2px; }
  .pj-modal-val { font-size: 14px; color: var(--gray-700); white-space: pre-wrap; word-break: break-word; }
  .pj-modal-input, .pj-modal-textarea, .pj-modal-select {
    width: 100%; padding: 10px 12px; border: 1px solid var(--gray-300); border-radius: 8px;
    font-size: 15px; font-family: inherit; box-sizing: border-box; background: #fff;
  }
  .pj-modal-input:focus, .pj-modal-textarea:focus, .pj-modal-select:focus { outline: none; border-color: var(--green); }
  .pj-modal-textarea { min-height: 80px; resize: vertical; }
  .pj-modal-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
  .pj-btn { padding: 10px 12px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
  .pj-btn-primary { background: var(--green); color: #fff; }
  .pj-btn-blue { background: #1E88E5; color: #fff; }
  .pj-btn-amber { background: #F59E0B; color: #fff; }
  .pj-btn-red { background: #E53935; color: #fff; }
  .pj-btn-secondary { background: #fff; color: var(--gray-700); border: 1px solid var(--gray-300); }
  .pj-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .pj-btn.full { grid-column: 1 / -1; }
  .pj-modal-error { color: var(--high); font-size: 13px; margin-top: 8px; }
  .pj-modal-status { font-size: 13px; color: var(--gray-500); margin-top: 8px; }
  .pj-radio-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
  .pj-radio-row label { display: flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }
  .pj-section-divider { border: none; border-top: 1px solid var(--gray-100); margin: 16px 0 8px; }

  @media (max-width: 767px) {
    .pj-table { display: none; }
    .pj-cards { display: block; }
  }
  @media (min-width: 768px) {
    .pj-table { display: table; }
    .pj-cards { display: none; }
    .pj-modal-bg { align-items: center; }
    .pj-modal { border-radius: 14px; max-height: 80vh; }
  }
`;

function injectCSS() {
  if (document.getElementById('hd-projects-css')) return;
  const style = document.createElement('style');
  style.id = 'hd-projects-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function getRoot(): HTMLElement {
  let root = document.getElementById('app') || document.getElementById('root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  }
  return root;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const jst = new Date(d.getTime() + 9 * 60 * 60_000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

function isoToDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const jst = new Date(d.getTime() + 9 * 60 * 60_000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateInputToIsoJst(yyyy_mm_dd: string): string {
  return `${yyyy_mm_dd}T23:59:59+09:00`;
}

function priorityLabel(p: string): string {
  return p === 'high' ? '🔴 高' : p === 'low' ? '⚪ 低' : '🟡 中';
}

function statusLabel(s: string): string {
  return s === 'pending' ? '未着手'
    : s === 'in_progress' ? '着手中'
    : s === 'delayed' ? '遅延'
    : s === 'problem' ? '問題'
    : s === 'done' ? '完了'
    : s === 'cancelled' ? '取消'
    : s;
}

interface MeCtx {
  lineUserId: string;
  friendId: string;
  isAdmin: boolean;
  /** LIFF base URL — task_problem 等への遷移用 */
  liffBase: string;
}

async function fetchTab(lineUserId: string, tab: Tab): Promise<TasksResp | MetricsResp> {
  const res = await fetch(
    `/api/liff/projects?lineUserId=${encodeURIComponent(lineUserId)}&tab=${tab}`,
  );
  return (await res.json()) as TasksResp | MetricsResp;
}

function readTab(): Tab {
  const hp = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const t = hp.get('tab') as Tab | null;
  if (t && ['mine', 'all', 'active', 'done', 'metrics'].includes(t)) return t;
  return 'mine';
}

function writeTab(tab: Tab): void {
  const hp = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  hp.set('page', 'projects');
  hp.set('tab', tab);
  window.history.replaceState({}, '', `#${hp.toString()}`);
}

// ── モーダル ──────────────────────────────────────────────────────────────

let onModalClose: (() => void) | null = null;

function closeModal() {
  const el = document.getElementById('pj-modal-bg');
  if (el) el.remove();
  const cb = onModalClose;
  onModalClose = null;
  if (cb) cb();
}

function showModal(html: string, onClose?: () => void) {
  const existing = document.getElementById('pj-modal-bg');
  if (existing) existing.remove();
  const bg = document.createElement('div');
  bg.id = 'pj-modal-bg';
  bg.className = 'pj-modal-bg';
  bg.innerHTML = `<div class="pj-modal" id="pj-modal">${html}</div>`;
  bg.addEventListener('click', (e) => {
    if (e.target === bg) closeModal();
  });
  document.body.appendChild(bg);
  onModalClose = onClose ?? null;
}

function setModalError(message: string | null) {
  const root = document.getElementById('pj-modal');
  if (!root) return;
  let el = root.querySelector('.pj-modal-error') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'pj-modal-error';
    root.appendChild(el);
  }
  el.textContent = message ?? '';
}

function setModalStatus(message: string) {
  const root = document.getElementById('pj-modal');
  if (!root) return;
  let el = root.querySelector('.pj-modal-status') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'pj-modal-status';
    root.appendChild(el);
  }
  el.textContent = message;
}

// ── タスク詳細モーダル ────────────────────────────────────────────────────

function permissionsFor(task: TaskRow, me: MeCtx) {
  const isAssignee = task.assigneeFriendId === me.friendId;
  const isRequester = task.requesterFriendId === me.friendId;
  const isAdmin = me.isAdmin;
  const isClosed = task.status === 'done' || task.status === 'cancelled';
  const assigneeMarked = !!task.completionAssigneeMarkedAt;
  const requesterMarked = !!task.completionRequesterMarkedAt;
  return {
    isAssignee, isRequester, isAdmin, isClosed,
    canProgress: !isClosed && (isAssignee || isAdmin),
    canCompleteAssignee: !isClosed && (isAssignee || isAdmin) && !assigneeMarked,
    canCompleteRequester: !isClosed && (isRequester || isAdmin) && !requesterMarked,
    canPostpone: !isClosed && (isAssignee || isAdmin),
    canProblem: !isClosed,
    canEdit: !isClosed && (isRequester || isAdmin),
    canCancel: task.status !== 'cancelled' && task.status !== 'done' && (isRequester || isAdmin),
  };
}

function openTaskModal(task: TaskRow, me: MeCtx, onChanged: () => void) {
  const perms = permissionsFor(task, me);
  const assignBadge = task.completionAssigneeMarkedAt ? '✅' : '⬜';
  const reqBadge = task.completionRequesterMarkedAt ? '✅' : '⬜';
  showModal(`
    <div class="pj-modal-head">
      <div>
        <div class="pj-modal-title">
          <span class="pj-pri pj-pri-${escapeHtml(task.priority)}">${priorityLabel(task.priority)}</span>
          ${escapeHtml(task.displayId)} ${escapeHtml(task.title)}
        </div>
        <div style="margin-top:4px"><span class="pj-status pj-status-${escapeHtml(task.status)}">${statusLabel(task.status)}</span></div>
      </div>
      <button class="pj-modal-close" id="pj-close">✕</button>
    </div>

    <div class="pj-modal-row">
      <div class="pj-modal-label">担当 / 依頼</div>
      <div class="pj-modal-val">${escapeHtml(task.assigneeName ?? '—')} ← ${escapeHtml(task.requesterName ?? '—')}</div>
    </div>
    <div class="pj-modal-row">
      <div class="pj-modal-label">期日</div>
      <div class="pj-modal-val">${formatDate(task.dueAt)}${task.postponeCount > 0 ? ` <span style="color:#F4511E">（延期${task.postponeCount}回）</span>` : ''}</div>
    </div>
    ${task.completedAt ? `<div class="pj-modal-row"><div class="pj-modal-label">完了日</div><div class="pj-modal-val">${formatDate(task.completedAt)}</div></div>` : ''}
    <div class="pj-modal-row">
      <div class="pj-modal-label">メモ</div>
      <div class="pj-modal-val">${task.description ? escapeHtml(task.description) : '（なし）'}</div>
    </div>
    ${task.status !== 'done' && task.status !== 'cancelled' ? `
    <div class="pj-modal-row">
      <div class="pj-modal-label">完了2段階承認</div>
      <div class="pj-modal-val">${assignBadge} 担当者 完了報告 / ${reqBadge} 依頼者 完了承認</div>
    </div>` : ''}

    ${!perms.isClosed ? `
      <hr class="pj-section-divider"/>
      <div class="pj-modal-label">📝 進捗を書く（依頼者・admin に転送されます）</div>
      <textarea class="pj-modal-textarea" id="pj-progress-text" maxlength="1000" placeholder="例: バナー1次案完成、デザインレビュー依頼中" ${!perms.canProgress ? 'disabled' : ''}></textarea>
      <div class="pj-modal-actions" style="grid-template-columns:1fr;">
        <button class="pj-btn pj-btn-primary" id="pj-progress-send" ${!perms.canProgress ? 'disabled' : ''}>送信</button>
      </div>
    ` : ''}

    <hr class="pj-section-divider"/>
    <div class="pj-modal-actions">
      ${perms.canCompleteAssignee ? `<button class="pj-btn pj-btn-primary" id="pj-act-complete-a">🎉 完了報告 (担当)</button>` : ''}
      ${perms.canCompleteRequester ? `<button class="pj-btn pj-btn-blue" id="pj-act-complete-r">✅ 完了承認 (依頼)</button>` : ''}
      ${perms.canPostpone ? `<button class="pj-btn pj-btn-amber" id="pj-act-postpone">⏰ 遅延+N日</button>` : ''}
      ${perms.canProblem ? `<button class="pj-btn pj-btn-secondary" id="pj-act-problem">⚠️ 問題報告</button>` : ''}
      ${perms.canEdit ? `<button class="pj-btn pj-btn-secondary" id="pj-act-edit">✏️ 編集</button>` : ''}
      ${perms.canCancel ? `<button class="pj-btn pj-btn-red" id="pj-act-cancel">❌ 取消</button>` : ''}
    </div>
  `, onChanged);

  document.getElementById('pj-close')?.addEventListener('click', () => closeModal());
  document.getElementById('pj-progress-send')?.addEventListener('click', () => sendProgress(task, me, onChanged));
  document.getElementById('pj-act-complete-a')?.addEventListener('click', () => actComplete(task, me, 'assignee', onChanged));
  document.getElementById('pj-act-complete-r')?.addEventListener('click', () => actComplete(task, me, 'requester', onChanged));
  document.getElementById('pj-act-postpone')?.addEventListener('click', () => openPostponeUI(task, me, onChanged));
  document.getElementById('pj-act-problem')?.addEventListener('click', () => {
    closeModal();
    const url = `${me.liffBase.replace(/#.*$/, '')}#page=task_problem&taskId=${encodeURIComponent(task.id)}`;
    window.location.href = url;
  });
  document.getElementById('pj-act-edit')?.addEventListener('click', () => openEditUI(task, me, onChanged));
  document.getElementById('pj-act-cancel')?.addEventListener('click', () => actCancel(task, me, onChanged));
}

// ── 進捗報告 ──────────────────────────────────────────────────────────────

async function sendProgress(task: TaskRow, me: MeCtx, onChanged: () => void) {
  const textEl = document.getElementById('pj-progress-text') as HTMLTextAreaElement | null;
  if (!textEl) return;
  const text = (textEl.value || '').trim();
  if (!text) { setModalError('進捗を入力してください'); return; }
  setModalError(null);
  setModalStatus('送信中…');
  try {
    const res = await fetch(`/api/liff/tasks/${encodeURIComponent(task.id)}/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: me.lineUserId, text }),
    });
    const json = await res.json() as { success: boolean; error?: string };
    if (!json.success) { setModalError(json.error ?? '送信失敗'); setModalStatus(''); return; }
    setModalStatus('✅ 進捗を共有しました');
    setTimeout(() => { closeModal(); onChanged(); }, 800);
  } catch (e) { setModalError((e as Error).message); setModalStatus(''); }
}

// ── 完了報告 / 完了承認 ───────────────────────────────────────────────────

async function actComplete(task: TaskRow, me: MeCtx, kind: 'assignee' | 'requester', onChanged: () => void) {
  setModalError(null);
  setModalStatus('送信中…');
  try {
    const res = await fetch(`/api/liff/tasks/${encodeURIComponent(task.id)}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: me.lineUserId, kind }),
    });
    const json = await res.json() as { success: boolean; error?: string; data?: { finalized: boolean; alreadyMarked: boolean } };
    if (!json.success) { setModalError(json.error ?? '送信失敗'); setModalStatus(''); return; }
    if (json.data?.finalized) setModalStatus('✅ 双方承認・完了確定しました');
    else if (json.data?.alreadyMarked) setModalStatus('既にマーク済みです');
    else setModalStatus(kind === 'assignee' ? '🟢 担当者として完了報告 (依頼者の承認待ち)' : '🟢 依頼者として完了承認 (担当者の完了報告待ち)');
    setTimeout(() => { closeModal(); onChanged(); }, 1000);
  } catch (e) { setModalError((e as Error).message); setModalStatus(''); }
}

// ── 遅延報告 ──────────────────────────────────────────────────────────────

function openPostponeUI(task: TaskRow, me: MeCtx, onChanged: () => void) {
  const root = document.getElementById('pj-modal');
  if (!root) return;
  const actionsEl = root.querySelector('.pj-modal-actions') as HTMLElement | null;
  if (!actionsEl) return;
  actionsEl.outerHTML = `
    <hr class="pj-section-divider"/>
    <div class="pj-modal-label">⏰ 何日遅延しますか?</div>
    <div class="pj-radio-row">
      <label><input type="radio" name="days" value="1" checked /> +1日</label>
      <label><input type="radio" name="days" value="2" /> +2日</label>
      <label><input type="radio" name="days" value="3" /> +3日</label>
      <label><input type="radio" name="days" value="7" /> +7日</label>
    </div>
    <div class="pj-modal-actions">
      <button class="pj-btn pj-btn-secondary" id="pj-postpone-cancel">戻る</button>
      <button class="pj-btn pj-btn-amber" id="pj-postpone-go">遅延を反映</button>
    </div>
  `;
  document.getElementById('pj-postpone-cancel')?.addEventListener('click', () => openTaskModal(task, me, onChanged));
  document.getElementById('pj-postpone-go')?.addEventListener('click', async () => {
    const r = document.querySelector('input[name="days"]:checked') as HTMLInputElement | null;
    const days = Number(r?.value || 1);
    setModalError(null); setModalStatus('送信中…');
    try {
      const res = await fetch(`/api/liff/tasks/${encodeURIComponent(task.id)}/postpone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: me.lineUserId, days }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      if (!json.success) { setModalError(json.error ?? '送信失敗'); setModalStatus(''); return; }
      setModalStatus(`✅ ${days}日遅延を反映しました`);
      setTimeout(() => { closeModal(); onChanged(); }, 800);
    } catch (e) { setModalError((e as Error).message); setModalStatus(''); }
  });
}

// ── 編集 ──────────────────────────────────────────────────────────────────

function openEditUI(task: TaskRow, me: MeCtx, onChanged: () => void) {
  const root = document.getElementById('pj-modal');
  if (!root) return;
  const actionsEl = root.querySelector('.pj-modal-actions') as HTMLElement | null;
  if (!actionsEl) return;
  actionsEl.outerHTML = `
    <hr class="pj-section-divider"/>
    <div class="pj-modal-label">✏️ 編集</div>
    <div class="pj-modal-row">
      <div class="pj-modal-label">タスク内容</div>
      <input class="pj-modal-input" id="pj-e-title" value="${escapeHtml(task.title)}" maxlength="200" />
    </div>
    <div class="pj-modal-row">
      <div class="pj-modal-label">メモ</div>
      <textarea class="pj-modal-textarea" id="pj-e-desc" maxlength="2000">${task.description ? escapeHtml(task.description) : ''}</textarea>
    </div>
    <div class="pj-modal-row">
      <div class="pj-modal-label">期日</div>
      <input class="pj-modal-input" id="pj-e-due" type="date" value="${isoToDateInput(task.dueAt)}" />
    </div>
    <div class="pj-modal-row">
      <div class="pj-modal-label">優先度</div>
      <div class="pj-radio-row">
        <label><input type="radio" name="pri" value="high" ${task.priority==='high'?'checked':''} /> 🔴 高</label>
        <label><input type="radio" name="pri" value="medium" ${task.priority==='medium'?'checked':''} /> 🟡 中</label>
        <label><input type="radio" name="pri" value="low" ${task.priority==='low'?'checked':''} /> ⚪ 低</label>
      </div>
    </div>
    <div class="pj-modal-actions">
      <button class="pj-btn pj-btn-secondary" id="pj-edit-cancel">戻る</button>
      <button class="pj-btn pj-btn-primary" id="pj-edit-save">💾 保存</button>
    </div>
  `;
  document.getElementById('pj-edit-cancel')?.addEventListener('click', () => openTaskModal(task, me, onChanged));
  document.getElementById('pj-edit-save')?.addEventListener('click', async () => {
    const title = (document.getElementById('pj-e-title') as HTMLInputElement).value;
    const desc = (document.getElementById('pj-e-desc') as HTMLTextAreaElement).value;
    const dueDate = (document.getElementById('pj-e-due') as HTMLInputElement).value;
    const pri = (document.querySelector('input[name="pri"]:checked') as HTMLInputElement | null)?.value as 'high'|'medium'|'low' | undefined;
    setModalError(null); setModalStatus('保存中…');
    try {
      const res = await fetch(`/api/liff/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: me.lineUserId,
          title,
          description: desc,
          dueAt: dueDate ? dateInputToIsoJst(dueDate) : undefined,
          priority: pri,
        }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      if (!json.success) { setModalError(json.error ?? '保存失敗'); setModalStatus(''); return; }
      setModalStatus('✅ 保存しました');
      setTimeout(() => { closeModal(); onChanged(); }, 800);
    } catch (e) { setModalError((e as Error).message); setModalStatus(''); }
  });
}

// ── 取消 ──────────────────────────────────────────────────────────────────

async function actCancel(task: TaskRow, me: MeCtx, onChanged: () => void) {
  const ok = confirm(`「${task.title}」を取り消しますか? この操作は履歴に残ります。`);
  if (!ok) return;
  setModalError(null); setModalStatus('送信中…');
  try {
    const res = await fetch(`/api/liff/tasks/${encodeURIComponent(task.id)}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: me.lineUserId }),
    });
    const json = await res.json() as { success: boolean; error?: string };
    if (!json.success) { setModalError(json.error ?? '送信失敗'); setModalStatus(''); return; }
    setModalStatus('✅ 取消しました');
    setTimeout(() => { closeModal(); onChanged(); }, 800);
  } catch (e) { setModalError((e as Error).message); setModalStatus(''); }
}

// ── 一覧描画 ─────────────────────────────────────────────────────────────

function renderTaskList(target: HTMLElement, rows: TaskRow[], me: MeCtx, reload: () => void) {
  if (rows.length === 0) {
    target.innerHTML = '<div class="pj-empty">該当タスクなし</div>';
    return;
  }
  const cards = rows.map((t) => `
    <div class="pj-card" data-id="${escapeHtml(t.id)}">
      <div class="pj-card-head">
        <span class="pj-pri pj-pri-${escapeHtml(t.priority)}">${priorityLabel(t.priority)}</span>
        <span class="pj-display-id">${escapeHtml(t.displayId)}</span>
        <span class="pj-title">${escapeHtml(t.title)}</span>
        <span class="pj-status pj-status-${escapeHtml(t.status)}">${statusLabel(t.status)}</span>
      </div>
      <div class="pj-meta">
        <span>担当: ${escapeHtml(t.assigneeName ?? '—')}</span>
        <span>依頼: ${escapeHtml(t.requesterName ?? '—')}</span>
        <span>期日: ${formatDate(t.dueAt)}</span>
        ${t.status === 'done' && t.completedAt ? `<span>完了: ${formatDate(t.completedAt)}</span>` : ''}
        ${t.postponeCount > 0 ? `<span style="color:#F4511E">延期${t.postponeCount}回</span>` : ''}
      </div>
    </div>
  `).join('');

  const tableRows = rows.map((t) => `
    <tr data-id="${escapeHtml(t.id)}">
      <td><span class="pj-pri pj-pri-${escapeHtml(t.priority)}">${priorityLabel(t.priority)}</span></td>
      <td>${escapeHtml(t.displayId)}</td>
      <td>${escapeHtml(t.title)}</td>
      <td><span class="pj-status pj-status-${escapeHtml(t.status)}">${statusLabel(t.status)}</span></td>
      <td>${escapeHtml(t.assigneeName ?? '—')}</td>
      <td>${escapeHtml(t.requesterName ?? '—')}</td>
      <td class="pj-num">${formatDate(t.dueAt)}</td>
      <td class="pj-num">${t.status === 'done' ? formatDate(t.completedAt) : (t.postponeCount > 0 ? `延期${t.postponeCount}` : '—')}</td>
    </tr>
  `).join('');

  target.innerHTML = `
    <div class="pj-cards">${cards}</div>
    <table class="pj-table">
      <thead><tr>
        <th>優先</th><th>ID</th><th>タスク</th><th>状態</th><th>担当</th><th>依頼</th><th>期日</th><th>備考</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;

  // クリックでモーダル開く
  const byId = new Map<string, TaskRow>();
  for (const r of rows) byId.set(r.id, r);
  const handler = (e: Event) => {
    const el = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
    if (!el) return;
    const id = el.getAttribute('data-id');
    if (!id) return;
    const t = byId.get(id);
    if (!t) return;
    openTaskModal(t, me, reload);
  };
  target.querySelectorAll<HTMLElement>('.pj-card').forEach((el) => el.addEventListener('click', handler));
  target.querySelectorAll<HTMLElement>('.pj-table tbody tr').forEach((el) => el.addEventListener('click', handler));
}

function renderMetrics(target: HTMLElement, rows: MetricsRow[]) {
  if (rows.length === 0) {
    target.innerHTML = '<div class="pj-empty">メトリクスなし</div>';
    return;
  }
  const cards = rows.map((m) => `
    <div class="pj-card" style="cursor:default">
      <div class="pj-card-head">
        <span class="pj-title">${escapeHtml(m.displayName ?? '—')}</span>
      </div>
      <div class="pj-meta">
        <span style="color:#C62828">申告漏れ: ${m.noReportCount}</span>
        <span style="color:#2E7D32">期日内報告: ${m.reportedOnTimeCount}</span>
        <span style="color:#E65100">遅延報告: ${m.delayReportCount}</span>
      </div>
    </div>
  `).join('');
  const tableRows = rows.map((m) => `
    <tr style="cursor:default">
      <td>${escapeHtml(m.displayName ?? '—')}</td>
      <td class="pj-num" style="color:#C62828">${m.noReportCount}</td>
      <td class="pj-num" style="color:#2E7D32">${m.reportedOnTimeCount}</td>
      <td class="pj-num" style="color:#E65100">${m.delayReportCount}</td>
    </tr>
  `).join('');
  target.innerHTML = `
    <div class="pj-cards">${cards}</div>
    <table class="pj-table">
      <thead><tr><th>名前</th><th>申告漏れ</th><th>期日内報告</th><th>遅延報告</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
}

// ── エントリーポイント ────────────────────────────────────────────────────

export async function initProjects(): Promise<void> {
  injectCSS();
  const root = getRoot();

  root.innerHTML = `
    <div class="pj-container">
      <div class="pj-header">📋 プロジェクト一覧</div>
      <div class="pj-tabs" id="pj-tabs"></div>
      <div id="pj-body"><div class="pj-loading">読み込み中…</div></div>
    </div>
  `;
  const tabsEl = document.getElementById('pj-tabs')!;
  const bodyEl = document.getElementById('pj-body')!;

  const profile = await liff.getProfile().catch(() => null);
  if (!profile) {
    bodyEl.innerHTML = '<div class="pj-empty">プロフィール取得に失敗しました。LINE 内で再度開いてください。</div>';
    return;
  }
  const liffBase = window.location.origin + (window.location.pathname.startsWith('/projects') ? '/' : window.location.pathname);
  // hash 形式で他 LIFF page に飛ぶときは LIFF URL を使うと最も互換性高い
  const liffBaseHash = (() => {
    const m = window.location.href.match(/^(https:\/\/liff\.line\.me\/[^/#?]+)/);
    return m ? m[1] : liffBase;
  })();

  const me: MeCtx = {
    lineUserId: profile.userId,
    friendId: '',
    isAdmin: false,
    liffBase: liffBaseHash,
  };

  let currentTab = readTab();

  async function load(tab: Tab) {
    bodyEl.innerHTML = '<div class="pj-loading">読み込み中…</div>';
    const resp = await fetchTab(me.lineUserId, tab);
    if (!resp.success) {
      bodyEl.innerHTML = `<div class="pj-empty">${escapeHtml(resp.error || 'エラーが発生しました')}</div>`;
      return;
    }
    me.isAdmin = resp.me?.isAdmin ?? false;
    me.friendId = resp.me?.friendId ?? '';
    renderTabs();
    if (tab === 'metrics') {
      renderMetrics(bodyEl, (resp as MetricsResp).data);
    } else {
      renderTaskList(bodyEl, (resp as TasksResp).data, me, () => load(tab));
    }
  }

  function renderTabs() {
    const labels: Array<{ key: Tab; label: string; show: boolean }> = [
      { key: 'mine',    label: '📋 個人タスク',    show: true },
      { key: 'all',     label: '🗂 プロジェクト一覧', show: true },
      { key: 'active',  label: '⏳ 進行中',       show: true },
      { key: 'done',    label: '✅ 完了',         show: true },
      { key: 'metrics', label: '📊 報告状況',     show: me.isAdmin },
    ];
    tabsEl.innerHTML = labels
      .filter((l) => l.show)
      .map(
        (l) => `<button class="pj-tab${currentTab === l.key ? ' active' : ''}" data-tab="${l.key}">${l.label}</button>`,
      )
      .join('');
    tabsEl.querySelectorAll<HTMLButtonElement>('.pj-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-tab') as Tab;
        if (!t || t === currentTab) return;
        currentTab = t;
        writeTab(t);
        load(t);
      });
    });
  }

  renderTabs();
  await load(currentTab);
}
