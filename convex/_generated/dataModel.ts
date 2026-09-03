/* eslint-disable */
/**
 * Generated data model types.
 *
 * Regenerate with `npx convex dev` after linking a deployment.
 */
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  SystemTableNames,
  TableNamesInDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;
