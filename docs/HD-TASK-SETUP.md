# HD TaskBot — セットアップガイド

このドキュメントは LINE Harness を fork した本リポジトリ (`shunsuke-tnk/hd-task-line-harness`) を、HD タスク管理 bot として稼働させるための初期セットアップ手順をまとめたものです。

> 上流の汎用ドキュメント:
> - クイックスタート全体: `README.md`
> - LIFF と LINE Login: `docs/wiki/Getting-Started.md`
> - リッチメニュー API: `docs/wiki/09-Rich-Menus.md`
> - スタッフ管理: `docs/wiki/25-Staff-Management.md`

## 0. 概要

本 fork に追加されたもの:

| 区分 | 追加内容 |
|---|---|
| DB | `tasks` / `task_events` / `staff_metrics` テーブル (migration 029) |
| Worker | `/api/tasks/*`, `/api/staff-metrics`, `/api/liff/tasks`, `/api/liff/staff-list`, `/api/liff/proposals` |
| Webhook | postback dispatcher (`action=task_*` / `metrics_show` / `request_or_propose_open` 等) |
| Flex | タスクカード / カルーセル / 遅延メニュー / 完了確認 / 取り消し確認 / リマインド / メトリクス |
| LIFF | `?page=task_request` / `?page=task_problem` / `?page=request_or_propose` |
| Cron | 期日前日 (18:00 JST) / 当日 (09:00 JST) / 超過 (5分毎) |

役割は LINE Harness の `tags` 機能 (`role:admin` / `role:staff`) で表現し、リッチメニューを `automation` で自動切替します。

---

## 1. LINE 公式アカウント (Option B: 既存 Messaging API チャネル再利用 + 新規 LINE Login チャネル)

### 1-1. Messaging API チャネル — 既存「業務支援Botくん (TaskBot)」を再利用

[LINE Developers Console](https://developers.line.biz/console/) で既存 TaskBot チャネルを開く。

- 既存の **チャネルシークレット** / **チャネルアクセストークン** をそのまま使用
- OpenClaw `~/.openclaw/.env` に `LINE_WORK_CHANNEL_SECRET` / `LINE_WORK_CHANNEL_ACCESS_TOKEN` として保存済 → これを取り出して LINE Harness 側に投入
- **設定変更**:
  - 応答メッセージ: **オフ** (LINE Harness が完全制御するため)
  - Webhook 利用: **オン**
  - Webhook URL は **ここではまだ書き換えない** (Phase 1 のデプロイ完了後に切替)

### 1-2. LINE Login チャネル — 新規作成

LIFF と UID 取得用に **新規** で 1 つ作成する。既存 Messaging API と同じ Provider 配下に作るのが推奨。

- 名前: 「業務 TaskBot Login」など
- Scope: `openid` `profile`
- アプリタイプ: ウェブアプリ
- LIFF アプリを 1 つ作成:
  - Endpoint URL: `https://<your-worker>.workers.dev/` (デプロイ後)
  - サイズ: Tall (推奨) / Compact のどちらでも可
  - Scope: `profile` `openid`

> 既存 TaskBot は LINE Login チャネルを持っていないため、これは新規作成必須。
> Messaging API チャネルとは別物だが、同じ Provider 配下なら友だち情報は共通化される。

## 2. Cloudflare 環境

```bash
npm install -g wrangler@latest
wrangler login

# D1 データベース作成
npx wrangler d1 create line-crm
# → 出力された database_id を apps/worker/wrangler.toml の YOUR_DEV_D1_DATABASE_ID に貼り付け

# スキーマ適用 (HD TaskBot 拡張テーブルも一括適用される)
npx wrangler d1 execute line-crm --file=packages/db/schema.sql

# 既存DBに対しては差分適用
npx wrangler d1 execute line-crm --file=packages/db/migrations/029_tasks.sql
```

シークレット投入:

```bash
cd apps/worker

# Option B: 既存 OpenClaw .env から値を取得して投入
source ~/.openclaw/.env

# 既存 TaskBot のチャネルシークレット / アクセストークンを再利用
echo "$LINE_WORK_CHANNEL_SECRET"        | npx wrangler secret put LINE_CHANNEL_SECRET
echo "$LINE_WORK_CHANNEL_ACCESS_TOKEN"  | npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN

# 新規発行する API キー (LINE Harness 管理画面/MCP からのアクセス用)
echo "$(openssl rand -hex 32)"          | npx wrangler secret put API_KEY

# 新規 LINE Login チャネルの値 (Phase 1-2 で LINE Console から取得)
echo "<login_channel_id>"               | npx wrangler secret put LINE_LOGIN_CHANNEL_ID
echo "<login_channel_secret>"           | npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET

# 環境変数 (デプロイ後に書き換えてもOK)
echo 'WORKER_URL = "https://<your-worker>.workers.dev"' >> wrangler.toml
echo 'LIFF_URL   = "https://liff.line.me/<LIFF_ID>"' >> wrangler.toml
echo 'LINE_CHANNEL_ID = "<messaging_api_channel_id>"' >> wrangler.toml
```

> 投入した API キーは安全な場所 (1Password 等) に控えておく。LINE Harness 管理画面のログインや MCP server 経由の API 呼び出しに使用。

## 3. デプロイ

```bash
pnpm install
pnpm --filter @line-crm/line-sdk build       # 上流の都合で先に line-sdk を build する必要あり
pnpm --filter worker build
pnpm --filter worker deploy                 # === wrangler deploy
```

### 3-1. Webhook URL を切替 (Option B のクリティカル工程)

LINE Console → 既存 TaskBot Messaging API チャネル → Messaging API → Webhook URL:

| | 値 |
|---|---|
| 旧 (OpenClaw 経由) | `https://tanakashunsukenomac-mini.tailcabd4c.ts.net:8443/line/webhook` |
| **新 (LINE Harness)** | `https://<your-worker>.workers.dev/webhook` |

「検証」ボタンで 200 OK を確認 → 保存。

**この瞬間から OpenClaw の work agent は LINE 受信を停止します。LINE Harness が引き取ります。**

> ロールバックが必要になった場合は LINE Console で旧 URL に戻すだけで OpenClaw 側に戻せる (OpenClaw 側を `enabled:false` にしていない限り)。Phase 7 で OpenClaw 側を停止するのは、LINE Harness が安定稼働してから。

### 3-2. 既存 friends を LINE Harness D1 に取り込む (任意)

既存 TaskBot で田中さん・光さんが友だちになっているが、LINE Harness の `friends` テーブルにはまだ無い。
ユーザーが LINE 公式に何かメッセージを送る or LIFF を開いた瞬間に webhook で自動 upsert されるが、待たずに事前投入したい場合は以下。

```bash
# OpenClaw side で friend list 取得
cat ~/.openclaw/workspace-work/TEAM.md | grep "userId"

# Friend ごとに LINE Harness D1 に直接 INSERT
npx wrangler d1 execute line-crm --remote --command "
INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id, metadata, created_at, updated_at)
VALUES
  ('<uuid>', 'U5d7ee1da8ebca511705659f416252e52', '光さん', 1, NULL, '{}', datetime('now'), datetime('now')),
  ('<uuid>', 'Ue7226d70034d350eba884a2b442da0cf', '田中俊輔', 1, NULL, '{}', datetime('now'), datetime('now'))
"
```

## 4. ロールタグの作成

API or 管理画面 (`apps/web`) で 2 つのタグを作る。MCP からの操作例:

```
> タグ「role:admin」を作成して
> タグ「role:staff」を作成して
```

API で直接:

```bash
curl -X POST https://<your-worker>.workers.dev/api/tags \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"role:admin","color":"#06C755"}'
curl -X POST https://<your-worker>.workers.dev/api/tags \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"role:staff","color":"#9E9E9E"}'
```

## 5. オートメーション (タグ自動付与・メニュー切替)

### 5-1. 友だち追加 → role:staff 自動付与

```bash
curl -X POST https://<your-worker>.workers.dev/api/automations \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "auto-tag-staff-on-add",
    "eventType": "friend_add",
    "conditions": {},
    "actions": [{"type":"add_tag","params":{"tagId":"<role:staff の tagId>"}}]
  }'
```

### 5-2. role:admin 付与 → 管理者メニューに切替

```bash
curl -X POST https://<your-worker>.workers.dev/api/automations \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "switch-admin-menu",
    "eventType": "tag_change",
    "conditions": {"tag_id":"<role:admin tagId>"},
    "actions": [{"type":"switch_rich_menu","params":{"richMenuId":"<admin_menu_id>"}}]
  }'
```

### 5-3. role:staff 付与 → 利用者メニューに切替

(同様、`tag_id` と `richMenuId` を staff 用に差し替え)

## 6. リッチメニュー作成

### サイズ: フル (2500x1686) 6分割

ボタンの postback data:

| グリッド | 管理者メニュー | 利用者メニュー |
|---|---|---|
| 左上 | `action=task_request_open` | `action=task_request_open` |
| 中上 | `action=task_complete_menu` | `action=task_complete_menu` |
| 右上 | `action=task_delay_menu` | `action=task_delay_menu` |
| 左下 | `action=task_problem_menu` | `action=task_problem_menu` |
| 中下 | `action=task_list_all` | `action=task_list_mine` |
| 右下 | `action=metrics_show` | `action=request_or_propose_open` |

### 作成

`assets/rich-menu/admin.png` (2500x1686) と `assets/rich-menu/staff.png` を用意した上で:

```bash
# Admin メニュー JSON
cat > /tmp/admin-menu.json <<'EOF'
{
  "size": {"width": 2500, "height": 1686},
  "selected": true,
  "name": "HD TaskBot Admin",
  "chatBarText": "メニュー",
  "areas": [
    {"bounds": {"x": 0,    "y": 0,    "width": 833,  "height": 843},  "action": {"type": "postback", "data": "action=task_request_open",    "displayText": "タスク依頼"}},
    {"bounds": {"x": 833,  "y": 0,    "width": 833,  "height": 843},  "action": {"type": "postback", "data": "action=task_complete_menu",   "displayText": "完了報告"}},
    {"bounds": {"x": 1666, "y": 0,    "width": 834,  "height": 843},  "action": {"type": "postback", "data": "action=task_delay_menu",      "displayText": "遅延報告"}},
    {"bounds": {"x": 0,    "y": 843,  "width": 833,  "height": 843},  "action": {"type": "postback", "data": "action=task_problem_menu",    "displayText": "問題報告"}},
    {"bounds": {"x": 833,  "y": 843,  "width": 833,  "height": 843},  "action": {"type": "postback", "data": "action=task_list_all",       "displayText": "タスク一覧"}},
    {"bounds": {"x": 1666, "y": 843,  "width": 834,  "height": 843},  "action": {"type": "postback", "data": "action=metrics_show",        "displayText": "遅延カウント"}}
  ]
}
EOF
# Staff メニュー JSON は task_list_all → task_list_mine, metrics_show → request_or_propose_open に差し替え

curl -X POST https://<your-worker>.workers.dev/api/rich-menus \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d @/tmp/admin-menu.json
# → richMenuId が返る → 画像をアップロード:
curl -X POST https://<your-worker>.workers.dev/api/rich-menus/<id>/image \
  -H "Authorization: Bearer $API_KEY" -F image=@assets/rich-menu/admin.png
```

> Staff 用は **デフォルトメニュー** に設定する:
> ```bash
> curl -X POST https://<your-worker>.workers.dev/api/rich-menus/<staff_menu_id>/default \
>   -H "Authorization: Bearer $API_KEY"
> ```

5-2 / 5-3 の automation で `richMenuId` をここで採番された値に差し替える。

## 7. 初期メンバーへの権限付与

光さん (admin):

```bash
# 1. 光さんが LINE 公式を友だち追加 → role:staff 自動付与済
# 2. 光さんを role:admin に昇格
curl -X POST https://<your-worker>.workers.dev/api/friends/<friend_id>/tags \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"tagId":"<role:admin tagId>"}'
# 自動的に管理者メニューへ切替される (automation 5-2)
```

田中俊輔 (admin or staff): 同様。

## 8. 動作確認チェックリスト

- [ ] 友だち追加 → 利用者メニューが表示される
- [ ] `role:admin` 付与 → 管理者メニューに切り替わる
- [ ] 管理者で「タスク依頼」→ LIFF フォーム が開く → 担当者選択リストに staff/admin friend が出る
- [ ] フォーム送信 → 担当者の LINE に Flex card 通知 (担当者を別アカウントで確認)
- [ ] 担当者で「完了報告」リッチメニュー → 自分のタスクカルーセル → [完了] → 確認 → 完了
- [ ] 依頼者の LINE に完了通知 push
- [ ] 期日が「明日」のタスクを作って 18:00 を待つ → 担当者にリマインド
- [ ] 期日が過去のタスクを作って5分以内に超過アラート → 担当者+依頼者+全admin に push
- [ ] 「遅延カウント」→ Flex bubble に全員のカウンタ
- [ ] 「依頼/提案」(staff) → LIFF フォーム送信 → 上司に届く

## 9. 既知の制限

- **タスク 1 件 = 担当者 1 名**: 複数担当は別タスクに分割するルール (要件定義どおり)
- **状態の手動 reopen は API 必須**: `done`/`cancelled` から戻したい場合は `POST /api/tasks/:id/events` で `reopened` イベントを残してから `PATCH` で status 戻す運用 (UI 未提供)
- **Worker 無料枠**: 100k req/日。HD 規模では到達しないが、超過時は Workers Paid ($5/mo)
- **LINE 無料プラン**: 200 通/月。リマインド頻度を超える場合は Light プラン (5000通/月) へ
- **マルチアカウント設定時**: タスクに `line_account_id` を記録するが、現状はリマインド push に default account の LineClient を使う (個別 access_token 解決は将来対応)

## 10. OpenClaw 側カットオーバー (Option B Phase 7)

LINE Harness が安定稼働 (動作確認チェックリスト全項目クリア) してから実施。
OpenClaw work agent を **削除せず**、LINE webhook 受信だけ止める。

### 10-1. OpenClaw の LINE channel を停止

```bash
# 1. 設定ファイルバックアップ
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-before-line-harness-cutover-$(date +%Y%m%d-%H%M%S)

# 2. channels.line.enabled を false に
openclaw config set channels.line.enabled false

# 3. gateway 再起動
openclaw gateway restart
```

### 10-2. Tailscale Funnel 8443 を停止

```bash
# LINE webhook 公開を閉じる (セキュリティ向上)
tailscale funnel --https=8443 off

# port 443 (tailnet-only dashboard) は維持
tailscale serve status
```

### 10-3. system crontab の notion-sync を停止

```bash
crontab -e
# `*/5 * * * * /Users/.../notion-sync-runner.sh` の行を削除
```

### 10-4. workspace-work を git commit (削除はしない)

```bash
cd ~/.openclaw/workspace-work
git add -A && git commit -m "freeze: pre-LINE-Harness-cutover snapshot"
git push
```

> **重要**: `~/.openclaw/agents/work/` と `~/.openclaw/workspace-work/` は **保持する**。
> LINE Harness が将来「AI 文面生成 (週次サマリー / ねぎらい文 / 壁打ち応答)」を OpenClaw 経由で行う際、
> SOUL.md / IDENTITY.md / CONVERSATION-STYLE-WORK.md を参照元として使用するため。

## 11. ロールバック手順

万一の障害時は:

### 11-1. 軽度: LINE Harness 側のみ停止
```bash
# Cron triggers を停止
npx wrangler triggers update --crons ""
```

### 11-2. 中度: OpenClaw に戻す (LINE webhook 復旧)
```bash
# OpenClaw 側を再有効化
openclaw config set channels.line.enabled true
openclaw gateway restart

# Tailscale Funnel 復旧
tailscale funnel --https=8443 --bg /line/webhook=http://127.0.0.1:18789

# LINE Console で Webhook URL を旧 Tailscale URL に戻す
```
これで OpenClaw work agent が LINE 受信を再開する (active.json と SOUL.md は保持しているのでチャット型運用に即時復帰可能)。

### 11-3. 重度: DB 拡張をロールバック
```bash
# タスク関連テーブルのみ削除 (LINE Harness 標準テーブルは残す)
echo "DROP TABLE IF EXISTS task_events; DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS staff_metrics;" | \
  npx wrangler d1 execute line-crm --command -
```

## 参考

- 計画書: `/Users/tanakashunsuke/.claude/plans/foamy-imagining-cat.md`
- データモデル詳細: `packages/db/migrations/029_tasks.sql`
- Flex Message 一覧: `apps/worker/src/services/task-flex.ts`
- Postback 仕様: `apps/worker/src/services/task-postback.ts` の冒頭コメント
