import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function getApiConfig() {
  const apiUrl = process.env.LINE_HARNESS_API_URL;
  const apiKey = process.env.LINE_HARNESS_API_KEY;
  if (!apiUrl || !apiKey) throw new Error("LINE_HARNESS_API_URL and LINE_HARNESS_API_KEY required");
  return { apiUrl, apiKey };
}

async function apiCall(path: string, method = "GET", body?: unknown) {
  const { apiUrl, apiKey } = getApiConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

export function registerManageTrafficPools(server: McpServer): void {
  server.tool(
    "manage_traffic_pools",
    "Traffic Pool の管理。list: 一覧、create: 作成、update: 更新（アカウント切替）、delete: 削除。poolのactiveAccountIdを変更するだけで全流入が別アカウントに切り替わる。",
    {
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      poolId: z.string().optional().describe("Pool ID (required for update, delete)"),
      slug: z.string().optional().describe("URL slug e.g. 'main' (for create)"),
      name: z.string().optional().describe("Pool name (for create, update)"),
      activeAccountId: z.string().optional().describe("LINE account ID to route traffic to (for create, update)"),
      isActive: z.boolean().optional().describe("Enable/disable the pool (for update)"),
    },
    async ({ action, poolId, slug, name, activeAccountId, isActive }) => {
      try {
        if (action === "list") {
          const data = await apiCall("/api/traffic-pools");
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        }

        if (action === "create") {
          if (!slug || !name || !activeAccountId) {
            throw new Error("slug, name, and activeAccountId are required for create");
          }
          const data = await apiCall("/api/traffic-pools", "POST", { slug, name, activeAccountId });
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        }

        if (action === "update") {
          if (!poolId) throw new Error("poolId is required for update");
          const body: Record<string, unknown> = {};
          if (name !== undefined) body.name = name;
          if (activeAccountId !== undefined) body.activeAccountId = activeAccountId;
          if (isActive !== undefined) body.isActive = isActive;
          const data = await apiCall(`/api/traffic-pools/${poolId}`, "PUT", body);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        }

        if (action === "delete") {
          if (!poolId) throw new Error("poolId is required for delete");
          const data = await apiCall(`/api/traffic-pools/${poolId}`, "DELETE");
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        }

        throw new Error(`Unknown action: ${action}`);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }, null, 2) }],
          isError: true,
        };
      }
    },
  );
}
