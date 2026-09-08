/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as bounds from "../bounds.js";
import type * as catalog from "../catalog.js";
import type * as catalogSeed from "../catalogSeed.js";
import type * as crons from "../crons.js";
import type * as deployment from "../deployment.js";
import type * as discovery from "../discovery.js";
import type * as events from "../events.js";
import type * as gifts from "../gifts.js";
import type * as http from "../http.js";
import type * as indexer from "../indexer.js";
import type * as monitor from "../monitor.js";
import type * as monitorAlerts from "../monitorAlerts.js";
import type * as noteIntegrity from "../noteIntegrity.js";
import type * as notes from "../notes.js";
import type * as observability from "../observability.js";
import type * as reconciliation from "../reconciliation.js";
import type * as retention from "../retention.js";
import type * as rpc from "../rpc.js";
import type * as webhooks from "../webhooks.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  bounds: typeof bounds;
  catalog: typeof catalog;
  catalogSeed: typeof catalogSeed;
  crons: typeof crons;
  deployment: typeof deployment;
  discovery: typeof discovery;
  events: typeof events;
  gifts: typeof gifts;
  http: typeof http;
  indexer: typeof indexer;
  monitor: typeof monitor;
  monitorAlerts: typeof monitorAlerts;
  noteIntegrity: typeof noteIntegrity;
  notes: typeof notes;
  observability: typeof observability;
  reconciliation: typeof reconciliation;
  retention: typeof retention;
  rpc: typeof rpc;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;

export declare const components: {};
