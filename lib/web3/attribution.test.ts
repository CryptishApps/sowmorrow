import { expect, it } from "vitest";
import { Attribution } from "ox/erc8021";
import { builderSuffix } from "./attribution";
it("encodes the configured builder code without inventing one when absent", () => {
  expect(builderSuffix(undefined)).toBeUndefined();
  expect(Attribution.fromData(builderSuffix("test_builder")!)).toMatchObject({ codes: ["test_builder"] });
});
