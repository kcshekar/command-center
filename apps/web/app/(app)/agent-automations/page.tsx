"use client";

import { SchedulesDashboard } from "@/components/schedules-dashboard";
import { ConnectedAccountsCompact } from "@/components/connected-accounts-compact";
import { CatalogList } from "@/components/catalog-list";
import { UserCredentialsSection } from "@/components/user-credentials-section";

export default function AutomationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Automations</h1>
        <p className="text-sm text-muted-foreground">
          Live schedules from Temporal, plus the account connections they rely on.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SchedulesDashboard />
        </div>
        <div className="lg:col-span-1">
          <ConnectedAccountsCompact />
        </div>
      </div>

      <CatalogList />

      <UserCredentialsSection />
    </div>
  );
}
