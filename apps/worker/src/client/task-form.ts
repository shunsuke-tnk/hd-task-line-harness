/**
 * HD TaskBot — LIFF forms
 *
 * Pages routed from main.ts switch:
 *   ?page=task_request       — タスク依頼フォーム
 *   ?page=task_problem       — 問題報告フォーム (?taskId=... 任意)
 *   ?page=request_or_propose — 依頼/提案フォーム (利用者専用)
 *
 * 共通フロー:
 *   1. liff.getProfile() で lineUserId を取得
 *   2. /api/liff/profile で friend を解決
 *   3. /api/friends?tag=... で TEAM 一覧 (タスク依頼の担当者選択用)
 *   4. /api/liff/tasks?lineUserId=... で 自分担当 / 依頼者タスク (問題報告の対象選択用)
 *   5. submit → /api/liff/tasks(.../problem|/proposals) に POST
 *   6. 成功時に liff.closeWindow()
 */

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string }>;
  isInClient(): boolean;
  closeWindow(): void;
};

interface FriendOption {
  id: string;
  displayName: string | null;
}

interface MyTaskOption {
  id: string;
  displayId: string;
  title: string;
  status: string;
  dueAt: string;
  isAssignee: boolean;
}

interface ProfileResp {
  success: boolean;
  data?: { id: string; displayName: string | null };
}

interface FriendsResp {
  success: boolean;
  data: Array<{ id: string; displayName: string | null }>;
}

interface MyTasksResp {
  success: boolean;
  data: Array<{
    id: string;
    displayId: string;
    title: string;
    status: string;
    dueAt: string;
    requesterFriendId: string;
    assigneeFriendId: string;
  }>;
  me: { friendId: string; isAdmin: boolean };
}

const CSS = `
  .form-card { max-width: 480px; margin: 0 auto; padding: 24px 16px; }
  .form-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; color: #06C755; }
  .form-row { margin-bottom: 16px; }
  .form-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #333; }
  .form-input, .form-select, .form-textarea {
    width: 100%; padding: 12px 14px; border: 1px solid #d0d0d0; border-radius: 8px;
    font-size: 16px; font-family: inherit; box-sizing: border-box; background: #fff;
  }
  .form-input:focus, .form-select:focus, .form-textarea:focus { outline: none; border-color: #06C755; }
  .form-textarea { min-height: 100px; resize: vertical; }
  .form-quick-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .form-quick-btn {
    padding: 8px 14px; border: 1px solid #06C755; border-radius: 999px;
    background: #fff; color: #06C755; font-size: 13px; cursor: pointer; font-family: inherit;
  }
  .form-quick-btn:active { background: #06C755; color: #fff; }
  .form-radio-row { display: flex; gap: 12px; margin-top: 6px; flex-wrap: wrap; }
  .form-radio-row label { display: flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }
  .form-submit {
    width: 100%; padding: 14px; background: #06C755; color: #fff; border: none;
    border-radius: 12px; font-size: 16px; font-weight: 700; margin-top: 12px; cursor: pointer;
  }
  .form-submit:disabled { background: #9e9e9e; cursor: not-allowed; }
  .form-help { font-size: 12px; color: #888; margin-top: 4px; }
  .form-error { color: #D32F2F; font-size: 13px; margin-top: 8px; }
  .form-success { padding: 32px 16px; text-align: center; }
  .form-success-icon { font-size: 48px; }
  .form-success-title { font-size: 18px; font-weight: 700; margin: 12px 0 6px; color: #06C755; }
  .form-success-text { font-size: 14px; color: #555; }
`;

function injectCSS() {
  if (document.getElementById('hd-task-css')) return;
  const style = document.createElement('style');
  style.id = 'hd-task-css';
  style.textContent = CSS;
  document.head.appendChild(style);
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

function showSuccess(message: string) {
  const root = getRoot();
  root.innerHTML = `
    <div class="form-card">
      <div class="form-success">
        <div class="form-success-icon">✅</div>
        <div class="form-success-title">送信しました</div>
        <div class="form-success-text">${escapeHtml(message)}</div>
      </div>
    </div>
  `;
  setTimeout(() => {
    if (liff.isInClient()) liff.closeWindow();
  }, 2000);
}

function showError(root: HTMLElement, message: string) {
  let el = root.querySelector('.form-error') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'form-error';
    root.appendChild(el);
  }
  el.textContent = message;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function todayPlus(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60_000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateToIsoJst(yyyy_mm_dd: string): string {
  // 期日は当日 23:59:59 (JST) として扱う
  return `${yyyy_mm_dd}T23:59:59+09:00`;
}

async function resolveProfile(): Promise<{ lineUserId: string; friendId: string; displayName: string | null } | null> {
  const profile = await liff.getProfile();
  const res = await fetch('/api/liff/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineUserId: profile.userId }),
  });
  const json = (await res.json()) as ProfileResp;
  if (!json.success || !json.data) return null;
  return { lineUserId: profile.userId, friendId: json.data.id, displayName: json.data.displayName };
}

async function fetchFriends(): Promise<FriendOption[]> {
  // role:admin / role:staff の friend だけ取得したいが /api/friends は API キー必須なので
  // LIFF では公開エンドポイントがない。代替として /api/liff/friend-pickup を別途用意する想定。
  // MVP: クライアントサイドでは候補が固定 → サーバ側で /api/liff/staff-list を作る。
  const res = await fetch('/api/liff/staff-list');
  if (!res.ok) return [];
  const json = (await res.json()) as FriendsResp;
  return (json.data || []).map((d) => ({ id: d.id, displayName: d.displayName }));
}

async function fetchMyTasks(lineUserId: string): Promise<MyTaskOption[]> {
  const res = await fetch(`/api/liff/tasks?lineUserId=${encodeURIComponent(lineUserId)}&scope=mine`);
  if (!res.ok) return [];
  const json = (await res.json()) as MyTasksResp;
  return (json.data || []).map((t) => ({
    id: t.id,
    displayId: t.displayId,
    title: t.title,
    status: t.status,
    dueAt: t.dueAt,
    isAssignee: t.assigneeFriendId === json.me.friendId,
  }));
}

// ── タスク依頼フォーム ──────────────────────────────────────────────────────

export async function initTaskRequestPage(lineUserId: string) {
  injectCSS();
  const root = getRoot();
  const friends = await fetchFriends();
  const friendOptions = friends
    .map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.displayName || f.id.slice(0, 8))}</option>`)
    .join('');

  root.innerHTML = `
    <div class="form-card">
      <div class="form-title">📝 タスク依頼</div>
      <form id="task-request-form">
        <div class="form-row">
          <label class="form-label" for="title">タスク内容 (誰に何をお願いするか)</label>
          <input class="form-input" id="title" name="title" type="text" maxlength="200" required placeholder="例: 広告バナー一次案を作成" />
        </div>
        <div class="form-row">
          <label class="form-label" for="assignee">担当者</label>
          <select class="form-select" id="assignee" name="assignee" required>
            <option value="">選択してください</option>
            ${friendOptions}
          </select>
          <div class="form-help">担当者は1名のみ選んでください</div>
        </div>
        <div class="form-row">
          <label class="form-label" for="dueAt">期日</label>
          <input class="form-input" id="dueAt" name="dueAt" type="date" required value="${todayPlus(2)}" min="${todayPlus(0)}" />
          <div class="form-quick-row">
            <button type="button" class="form-quick-btn" data-days="1">+1日</button>
            <button type="button" class="form-quick-btn" data-days="2">+2日</button>
            <button type="button" class="form-quick-btn" data-days="3">+3日</button>
          </div>
          <div class="form-help">フレームワーク上は最長3日推奨です</div>
        </div>
        <div class="form-row">
          <label class="form-label" for="description">補足メモ (任意)</label>
          <textarea class="form-textarea" id="description" name="description" maxlength="500" placeholder="背景や合格条件など"></textarea>
        </div>
        <button type="submit" class="form-submit" id="submit-btn">依頼する</button>
      </form>
    </div>
  `;

  const form = document.getElementById('task-request-form') as HTMLFormElement;
  form.querySelectorAll<HTMLButtonElement>('.form-quick-btn[data-days]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = Number(btn.getAttribute('data-days'));
      const due = document.getElementById('dueAt') as HTMLInputElement;
      due.value = todayPlus(days);
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = '送信中…';
    try {
      const fd = new FormData(form);
      const body = {
        lineUserId,
        assigneeFriendId: String(fd.get('assignee') || ''),
        title: String(fd.get('title') || ''),
        dueAt: dateToIsoJst(String(fd.get('dueAt') || '')),
        description: String(fd.get('description') || ''),
      };
      const res = await fetch('/api/liff/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { success: boolean; error?: string; data?: { displayId: string; title: string } };
      if (!json.success) {
        showError(form, json.error || '送信に失敗しました');
        submitBtn.disabled = false;
        submitBtn.textContent = '依頼する';
        return;
      }
      showSuccess(`${json.data?.displayId ?? ''} ${json.data?.title ?? ''}`);
    } catch (err) {
      showError(form, (err as Error).message);
      submitBtn.disabled = false;
      submitBtn.textContent = '依頼する';
    }
  });
}

// ── 問題報告フォーム ───────────────────────────────────────────────────────

export async function initTaskProblemPage(lineUserId: string, taskIdHint: string | null) {
  injectCSS();
  const root = getRoot();
  const tasks = await fetchMyTasks(lineUserId);
  const options = tasks
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.displayId)} ${escapeHtml(t.title)}</option>`)
    .join('');

  root.innerHTML = `
    <div class="form-card">
      <div class="form-title">⚠️ 問題報告</div>
      <form id="task-problem-form">
        <div class="form-row">
          <label class="form-label" for="taskId">対象タスク</label>
          <select class="form-select" id="taskId" name="taskId" required>
            <option value="">選択してください</option>
            ${options}
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">緊急度</label>
          <div class="form-radio-row">
            <label><input type="radio" name="severity" value="low" /> 低</label>
            <label><input type="radio" name="severity" value="medium" checked /> 中</label>
            <label><input type="radio" name="severity" value="high" /> 高</label>
          </div>
        </div>
        <div class="form-row">
          <label class="form-label" for="text">問題の内容</label>
          <textarea class="form-textarea" id="text" name="text" maxlength="1000" required placeholder="何が起きていますか? 何があれば解決しそうですか?"></textarea>
        </div>
        <button type="submit" class="form-submit" id="submit-btn">報告する</button>
      </form>
    </div>
  `;

  const form = document.getElementById('task-problem-form') as HTMLFormElement;
  if (taskIdHint) {
    const sel = document.getElementById('taskId') as HTMLSelectElement;
    if (Array.from(sel.options).some((o) => o.value === taskIdHint)) sel.value = taskIdHint;
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = '送信中…';
    try {
      const fd = new FormData(form);
      const taskId = String(fd.get('taskId') || '');
      const body = {
        lineUserId,
        text: String(fd.get('text') || ''),
        severity: String(fd.get('severity') || 'medium'),
      };
      const res = await fetch(`/api/liff/tasks/${encodeURIComponent(taskId)}/problem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) {
        showError(form, json.error || '送信に失敗しました');
        submitBtn.disabled = false;
        submitBtn.textContent = '報告する';
        return;
      }
      showSuccess('担当者・依頼者に共有しました');
    } catch (err) {
      showError(form, (err as Error).message);
      submitBtn.disabled = false;
      submitBtn.textContent = '報告する';
    }
  });
}

// ── 依頼/提案フォーム (利用者専用) ──────────────────────────────────────────

export async function initRequestOrProposePage(lineUserId: string) {
  injectCSS();
  const root = getRoot();
  root.innerHTML = `
    <div class="form-card">
      <div class="form-title">💬 依頼 / 提案</div>
      <form id="propose-form">
        <div class="form-row">
          <label class="form-label">種別</label>
          <div class="form-radio-row">
            <label><input type="radio" name="kind" value="request" checked /> 仕事を振ってほしい</label>
            <label><input type="radio" name="kind" value="propose" /> 提案がある</label>
          </div>
        </div>
        <div class="form-row">
          <label class="form-label" for="text">内容</label>
          <textarea class="form-textarea" id="text" name="text" maxlength="1000" required placeholder="状況や提案をひとこと"></textarea>
        </div>
        <div class="form-row">
          <label class="form-label" for="preferredDueAt">推奨期日 (任意)</label>
          <input class="form-input" id="preferredDueAt" name="preferredDueAt" type="date" min="${todayPlus(0)}" />
        </div>
        <button type="submit" class="form-submit" id="submit-btn">送信</button>
      </form>
    </div>
  `;

  const form = document.getElementById('propose-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = '送信中…';
    try {
      const fd = new FormData(form);
      const body = {
        lineUserId,
        kind: String(fd.get('kind') || 'request'),
        text: String(fd.get('text') || ''),
        preferredDueAt: fd.get('preferredDueAt') ? dateToIsoJst(String(fd.get('preferredDueAt'))) : null,
      };
      const res = await fetch('/api/liff/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) {
        showError(form, json.error || '送信に失敗しました');
        submitBtn.disabled = false;
        submitBtn.textContent = '送信';
        return;
      }
      showSuccess('上司に届けました');
    } catch (err) {
      showError(form, (err as Error).message);
      submitBtn.disabled = false;
      submitBtn.textContent = '送信';
    }
  });
}

// ── ルーター ──────────────────────────────────────────────────────────────

export async function dispatchTaskPage(page: string): Promise<boolean> {
  const profile = await resolveProfile();
  if (!profile) {
    const root = getRoot();
    injectCSS();
    root.innerHTML = `<div class="form-card"><div class="form-title">アクセスエラー</div><p>友だち追加が完了していません。一度公式LINEを友だち追加してから再度お試しください。</p></div>`;
    return true;
  }
  const params = new URLSearchParams(window.location.search);
  if (page === 'task_request') {
    await initTaskRequestPage(profile.lineUserId);
    return true;
  }
  if (page === 'task_problem') {
    await initTaskProblemPage(profile.lineUserId, params.get('taskId'));
    return true;
  }
  if (page === 'request_or_propose') {
    await initRequestOrProposePage(profile.lineUserId);
    return true;
  }
  return false;
}
