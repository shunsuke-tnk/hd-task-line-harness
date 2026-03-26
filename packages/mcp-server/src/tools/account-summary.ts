import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

export function registerAccountSummary(server: McpServer): void {
  server.tool(
    "account_summary",
    "Get a high-level summary of the LINE account: friend count, active scenarios, recent broadcasts, tags, and forms. Use this to understand the current state before making changes.",
    {
      accountId: z.string().optional().describe("LINE account ID (uses default if omitted)"),
    },
    async ({ accountId }) => {
      try {
        const client = getClient();

        const [friendCount, scenarios, broadcasts, tags, forms] = await Promise.all([
          client.friends.count({ accountId }),
          client.scenarios.list({ accountId }),
          client.broadcasts.list({ accountId }),
          client.tags.list(),
          client.forms.list(),
        ]);

        const activeScenarios = scenarios.filter((s: any) => s.isActive);
        const recentBroadcasts = broadcasts.slice(0, 5);

        const summary = {
          friends: { total: friendCount },
          scenarios: {
            total: scenarios.length,
            active: activeScenarios.length,
            activeList: activeScenarios.map((s: any) => ({ id: s.id, name: s.name, triggerType: s.triggerType })),
          },
          broadcasts: {
            total: broadcasts.length,
            recent: recentBroadcasts.map((b: any) => ({ id: b.id, title: b.title, status: b.status, sentAt: b.sentAt })),
          },
          tags: {
            total: tags.length,
            list: tags.map((t: any) => ({ id: t.id, name: t.name })),
          },
          forms: {
            total: forms.length,
            list: forms.map((f: any) => ({ id: f.id, name: f.name })),
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(error) }, null, 2) }], isError: true };
      }
    }
  );
}
