import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { scanRepoDepUpgrades } = wf.proxyActivities<typeof activities>({
  // Sequential registry calls on a mid-sized monorepo can take a minute+.
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 2, initialInterval: "30s" },
});

export async function platformUpgradeScanWorkflow(input: { routeKey?: string; rootDir?: string } = {}): Promise<{
  packageJsons: number; depsExamined: number; upgrades: number;
  major: number; minor: number; patch: number; posted: boolean;
}> {
  return scanRepoDepUpgrades(input);
}
