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

## 1. LINE 公式アカウント (Messaging API + LINE Login)

[LINE Developers Console](https://developers.line.biz/console/) で **2 つのチャネル** を作成する。

1. **Messaging API チャネル** — 「業務 TaskBot」など
   - Webhook URL: `https://<your-worker>.workers.dev/webhook` (デプロイ後に登録)
   - Webhook 利用: **オン**
   - 応答メッセージ: **オフ** (Bot 側で完全制御するため)
   - あいさつメッセージ: 任意 (推奨: 「友だち追加ありがとうございます。下のメニューから操作してください」)
2. **LINE Login チャネル** — 「業務 TaskBot Login」など
   - LIFF アプリを 1 つ作成 (Endpoint: `https://<your-worker>.workers.dev/`)
   - Scope: `openid` `profile`

> 上流ドキュメントどおり Login チャネルがないと UUID 取得ができないので必須。

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
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put API_KEY                    # 管理者用 (oneshot)
npx wrangler secret put LINE_LOGIN_CHANNEL_ID
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET
# 環境変数 (worker.workers.dev のドメインを後で書き換えても可)
echo 'WORKER_URL = "https://<your-worker>.workers.dev"' >> wrangler.toml
echo 'LIFF_URL   = "https://liff.line.me/<LIFF_ID>"' >> wrangler.toml
echo 'LINE_CHANNEL_ID = "<messaging_api_channel_id>"' >> wrangler.toml
```

## 3. デプロイ

```bash
pnpm install
pnpm --filter @line-crm/line-sdk build       # 上流の都合で先に line-sdk を build する必要あり
pnpm --filter worker build
pnpm --filter worker deploy                 # === wrangler deploy
```

LINE Console に Webhook URL を設定:
- `https://<your-worker>.workers.dev/webhook`
- 「検証」ボタンで 200 OK を確認

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

## 10. ロールバック手順

万一の障害時は:

```bash
# Cron triggers を停止
npx wrangler triggers update --crons ""

# Webhook URL を空に → LINE 側で受信停止
# LINE Developers Console → Webhook URL を空欄保存

# DB スキーマのロールバック (タスクのみ削除)
echo "DROP TABLE IF EXISTS task_events; DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS staff_metrics;" | \
  npx wrangler d1 execute line-crm --command -
```

## 参考

- 計画書: `/Users/tanakashunsuke/.claude/plans/foamy-imagining-cat.md`
- データモデル詳細: `packages/db/migrations/029_tasks.sql`
- Flex Message 一覧: `apps/worker/src/services/task-flex.ts`
- Postback 仕様: `apps/worker/src/services/task-postback.ts` の冒頭コメント
