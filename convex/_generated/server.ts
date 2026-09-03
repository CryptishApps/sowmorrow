/* eslint-disable */
/**
 * Generated server utilities.
 *
 * Regenerate with `npx convex dev` after linking a deployment.
 */
import {
  actionGeneric,
  httpActionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type {
  ActionBuilder,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import type { DataModel } from "./dataModel";

export const query = queryGeneric as QueryBuilder<DataModel, "public">;
export const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
export const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
export const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
export const action = actionGeneric as ActionBuilder<DataModel, "public">;
export const internalAction = internalActionGeneric as ActionBuilder<DataModel, "internal">;
export const httpAction = httpActionGeneric as HttpActionBuilder;

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
