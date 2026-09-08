import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "reconcile configured Sowmorrow vault",
  { minutes: 1 },
  internal.reconciliation.reconcileConfiguredVault,
);

crons.interval("retry due CDP deliveries", { minutes: 1 }, internal.reconciliation.retryDueDeliveries);

crons.interval(
  "scan B20 factory for stock candidates",
  { hours: 6 },
  internal.discovery.scanFactoryCandidates,
);

crons.interval(
  "check vault solvency and index lag",
  { minutes: 5 },
  internal.monitor.checkVaultSolvencyAndLag,
);

crons.daily(
  "prune terminal delivery and sync diagnostics",
  { hourUTC: 4, minuteUTC: 0 },
  internal.retention.pruneTerminalRecords,
  {},
);

export default crons;
