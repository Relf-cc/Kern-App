/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Settings → API (internal route /api/accounts, /api/routing, …): AI API
// credential profiles, routing and failover, usage, and security. This is
// an account manager for integrations, not a chat interface.

import { BarChart3, Bot, KeyRound, Route as RouteIcon, ShieldCheck } from "lucide-react";
import { navigate, type ApiTab } from "@/stores/router";
import { AccountsTab } from "./AccountsTab";
import { RoutingTab } from "./RoutingTab";
import { UsageTab } from "./UsageTab";
import { SecurityTab } from "./SecurityTab";
import { McpTab } from "./McpTab";

const TABS: { id: ApiTab; label: string; icon: typeof KeyRound }[] = [
  { id: "accounts", label: "Accounts", icon: KeyRound },
  { id: "routing", label: "Routing", icon: RouteIcon },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "mcp", label: "Assistants", icon: Bot },
];

export default function ApiPage({ tab = "accounts" }: { tab?: ApiTab }) {
  return (
    <div className="api-page">
      <nav className="tabs api-page__tabs" aria-label="API sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="tab" data-active={tab === t.id} onClick={() => navigate({ name: "api", tab: t.id }, { replace: true })}>
            <t.icon strokeWidth={1.75} />
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "accounts" && <AccountsTab />}
      {tab === "routing" && <RoutingTab />}
      {tab === "usage" && <UsageTab />}
      {tab === "security" && <SecurityTab />}
      {tab === "mcp" && <McpTab />}
    </div>
  );
}
