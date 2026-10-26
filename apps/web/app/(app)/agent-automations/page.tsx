"use client";

import { SchedulesDashboard } from "@/components/schedules-dashboard";
import { ConnectedAccountsCompact } from "@/components/connected-accounts-compact";
import { CatalogList } from "@/components/catalog-list";
import { UserCredentialsSection } from "@/components/user-credentials-section";

// 2×2 grid: top row = runtime (schedules + catalog), bottom row = credentials
// (connected accounts + BYOK). Each cell has a fixed max-height so the page
// stays "no scroll" at desktop widths and the heavy lists scroll inside their
// own card instead of pushing the layout.
function Cell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-h-[540px] overflow-y-auto rounded-2xl">
      {children}
    </div>
  );
}

export default function AutomationsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Automations control room</h1>
        <p className="text-sm text-muted-foreground">
          Live schedules from Temporal, the catalog you can toggle per user, the external accounts your automations talk to, and the API keys they use.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Cell><SchedulesDashboard /></Cell>
        <Cell><CatalogList /></Cell>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Cell><ConnectedAccountsCompact /></Cell>
        <Cell><UserCredentialsSection /></Cell>
      </div>
    </div>
  );
}
