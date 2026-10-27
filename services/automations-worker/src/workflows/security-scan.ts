import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

// N14 — weekly dependency security scan (system schedule n14-security-weekly).
const { scanDependencyVulns } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes", // ~1k packages, OSV batches of 500 + one detail call per advisory
  retry: { maximumAttempts: 2 },
});

export async function securityScanWorkflow(input: { routeKey?: string } = {}) {
  return scanDependencyVulns(input);
}
