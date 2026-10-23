/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Settings → API (internal route /api/accounts, /api/routing, …): AI API
// credential profiles, routing and failover, usage, and security. This is
// an account manager for integrations, not a chat interface. Its pages are
// listed under API in the settings rail, like any other settings navigation;
// this only shows the one that's open.

import type { ApiTab } from "@/stores/router";
import { AccountsTab } from "./AccountsTab";
import { RoutingTab } from "./RoutingTab";
import { UsageTab } from "./UsageTab";
import { SecurityTab } from "./SecurityTab";

export default function ApiPage({ tab = "accounts" }: { tab?: ApiTab }) {
  return (
    <div className="api-page">
      {tab === "accounts" && <AccountsTab />}
      {tab === "routing" && <RoutingTab />}
      {tab === "usage" && <UsageTab />}
      {tab === "security" && <SecurityTab />}
    </div>
  );
}
