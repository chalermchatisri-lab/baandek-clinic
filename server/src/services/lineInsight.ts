import { env } from "../lib/env";

// Read-only LINE Messaging API stats: rich menu impressions/clicks per button
// and this month's push-message quota. Nothing here sends a message or changes
// a rich menu — every call is a GET.
//
// Rich menus created through the Messaging API (ours) don't appear in LINE OA
// Manager, so their stats are only reachable via these insight endpoints.

const API = "https://api.line.me";

type Bounds = { x: number; y: number; width: number; height: number };
type Metrics = { count: number; uniqueUsers: number };

type RichMenuAction = {
  type: string;
  label?: string;
  text?: string;
  data?: string;
  uri?: string;
  richMenuAliasId?: string;
};

type RichMenu = {
  richMenuId: string;
  name?: string;
  chatBarText?: string;
  selected?: boolean;
  areas: { bounds: Bounds; action: RichMenuAction }[];
};

type InsightSummary = {
  richMenuId: string;
  metricsFrom?: string | null;
  metricsTo?: string | null;
  impression?: { metrics: Metrics };
  clicks?: { bounds: Bounds; metrics: Metrics }[];
};

export type RichMenuButtonStat = {
  button: string; // human-readable action description
  actionType: string;
  clicks: number | null;
  uniqueUsers: number | null;
};

export type RichMenuStat = {
  richMenuId: string;
  name: string | null;
  isDefault: boolean;
  metricsFrom: string | null;
  metricsTo: string | null;
  impressions: Metrics | null;
  // null when LINE withheld numbers (unique clicks below its privacy threshold)
  // or the insight call failed — see `note`.
  buttons: RichMenuButtonStat[];
  note: string | null;
};

async function lineGet<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${env.lineToken}` } });
  if (!res.ok) {
    return { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) };
  }
  return { ok: true, data: (await res.json()) as T };
}

function describeAction(a: RichMenuAction): string {
  if (a.label) return a.label;
  if (a.text) return a.text;
  if (a.uri) {
    try {
      const u = new URL(a.uri);
      return `${u.host}${u.pathname}`; // drop query string
    } catch {
      return a.uri.slice(0, 60);
    }
  }
  if (a.data) return a.data.slice(0, 60);
  if (a.richMenuAliasId) return `switch:${a.richMenuAliasId}`;
  return a.type;
}

const sameBounds = (a: Bounds, b: Bounds) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Today's date in LINE's insight timezone (UTC+9) as yyyyMMdd. */
export function todayUtc9(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 9 * 3600_000);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

export function isYyyyMmDd(s: string): boolean {
  return /^\d{8}$/.test(s);
}

/** Merge a rich menu's tappable areas with the click metrics LINE returns (matched by bounds). */
export function mergeButtons(menu: RichMenu, summary: InsightSummary | null): RichMenuButtonStat[] {
  return menu.areas.map((area) => {
    const hit = summary?.clicks?.find((c) => sameBounds(c.bounds, area.bounds));
    return {
      button: describeAction(area.action),
      actionType: area.action.type,
      clicks: summary?.clicks ? (hit?.metrics.count ?? 0) : null,
      uniqueUsers: summary?.clicks ? (hit?.metrics.uniqueUsers ?? 0) : null,
    };
  });
}

export async function getRichMenuStats(from: string, to: string) {
  const [list, def] = await Promise.all([
    lineGet<{ richmenus: RichMenu[] }>("/v2/bot/richmenu/list"),
    lineGet<{ richMenuId: string }>("/v2/bot/user/all/richmenu"),
  ]);
  if (!list.ok) return { ok: false as const, error: `richmenu/list HTTP ${list.status}: ${list.error}` };
  const defaultId = def.ok ? def.data.richMenuId : null;

  // Default menu first; cap the count — insight endpoints allow 60 req/hour.
  const menus = [...list.data.richmenus]
    .sort((a, b) => Number(b.richMenuId === defaultId) - Number(a.richMenuId === defaultId))
    .slice(0, 5);

  const stats: RichMenuStat[] = [];
  for (const menu of menus) {
    const s = await lineGet<InsightSummary>(
      `/v2/bot/insight/richmenu/${encodeURIComponent(menu.richMenuId)}/summary?from=${from}&to=${to}`,
    );
    const summary = s.ok ? s.data : null;
    let note: string | null = null;
    if (!s.ok) note = `insight HTTP ${s.status}: ${s.error}`;
    else if (!summary?.clicks) note = "LINE withheld numbers: too few unique clicks in this period (privacy threshold)";
    stats.push({
      richMenuId: menu.richMenuId,
      name: menu.name ?? null,
      isDefault: menu.richMenuId === defaultId,
      metricsFrom: summary?.metricsFrom ?? null,
      metricsTo: summary?.metricsTo ?? null,
      impressions: summary?.impression?.metrics ?? null,
      buttons: mergeButtons(menu, summary),
      note,
    });
  }

  const [quota, used] = await Promise.all([
    lineGet<{ type: string; value?: number }>("/v2/bot/message/quota"),
    lineGet<{ totalUsage: number }>("/v2/bot/message/quota/consumption"),
  ]);

  return {
    ok: true as const,
    period: { from, to },
    totalRichMenus: list.data.richmenus.length,
    defaultRichMenuId: defaultId,
    messageQuota: {
      limit: quota.ok ? (quota.data.value ?? null) : null,
      usedThisMonth: used.ok ? used.data.totalUsage : null,
    },
    richMenus: stats,
  };
}
