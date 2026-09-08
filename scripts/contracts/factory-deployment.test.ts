import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getContractAddress, parseAbiParameters, slice } from "viem";
import { prepareFactoryDeployment, deploymentFactory } from "./factory-deployment";
import { stocks } from "../../lib/stocks";

const owner = "0x00077DF28c24A199d33B30560Bda394819498a72";
it("binds the CREATE2 address and calldata to a paused vault with the selected owner and catalog", () => {
  const request = prepareFactoryDeployment("0x60016000", owner);
  expect(request.vault).toBe(
    getContractAddress({
      opcode: "CREATE2",
      from: deploymentFactory,
      salt: request.salt,
      bytecode: request.initCode,
    }),
  );
  expect(request.call.to).toBe(deploymentFactory);
  expect(request.call.value).toBe("0x0");
  expect(slice(request.call.data, 32)).toBe(request.initCode);
  const args = decodeAbiParameters(
    parseAbiParameters("address, address[], uint256[], bool"),
    slice(request.initCode, 4),
  );
  expect(args[0]).toBe(owner);
  expect(args[1]).toEqual(stocks.map((s) => s.mainnetAddress));
  expect(args[2]).toHaveLength(stocks.length);
  expect(args[3]).toBe(true);
});
describe("deployment inputs", () => {
  it("rejects an empty creation program and a zero owner", () => {
    expect(() => prepareFactoryDeployment("0x", owner)).toThrow();
    expect(() => prepareFactoryDeployment("0x6000", "0x0000000000000000000000000000000000000000")).toThrow();
  });
});
