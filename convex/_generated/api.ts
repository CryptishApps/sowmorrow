/* eslint-disable */
/**
 * Generated API utility.
 *
 * Regenerate with `npx convex dev` after linking a deployment.
 */
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi } from "convex/server";
import type * as bounds from "../bounds";
import type * as catalog from "../catalog";
import type * as catalogSeed from "../catalogSeed";
import type * as deployment from "../deployment";
import type * as discovery from "../discovery";
import type * as events from "../events";
import type * as gifts from "../gifts";
import type * as indexer from "../indexer";
import type * as monitor from "../monitor";
import type * as notes from "../notes";
import type * as observability from "../observability";
import type * as reconciliation from "../reconciliation";
import type * as retention from "../retention";
import type * as rpc from "../rpc";
import type * as webhooks from "../webhooks";

const fullApi: ApiFromModules<{
  bounds: typeof bounds;
  catalog: typeof catalog;
  catalogSeed: typeof catalogSeed;
  deployment: typeof deployment;
  discovery: typeof discovery;
  events: typeof events;
  gifts: typeof gifts;
  indexer: typeof indexer;
  monitor: typeof monitor;
  notes: typeof notes;
  observability: typeof observability;
  reconciliation: typeof reconciliation;
  retention: typeof retention;
  rpc: typeof rpc;
  webhooks: typeof webhooks;
}> = anyApi as any;

export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;
export const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">> = anyApi as any;
