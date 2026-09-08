import {
  concat,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  isHex,
  keccak256,
  parseAbiParameters,
  size,
  stringToHex,
  zeroAddress,
} from "viem";
import type { Address, Hex } from "viem";
import { stocks } from "../../lib/stocks";

export const deploymentFactory = getAddress("0x4e59b44847b379578588920ca78fbf26c0b4956c");
export const deploymentFactoryCode: Hex =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

export function prepareFactoryDeployment(creationCode: Hex, selectedOwner: Address) {
  const owner = getAddress(selectedOwner);
  if (owner === zeroAddress || !isHex(creationCode) || size(creationCode) === 0)
    throw new Error("A nonzero owner and compiled creation code are required");
  const minimums = stocks.map((stock) =>
    stock.symbol === "INTCc" || stock.symbol === "SNDKc" ? 2n * 10n ** 17n : 10n ** 16n,
  );
  const initCode = concat([
    creationCode,
    encodeAbiParameters(parseAbiParameters("address, address[], uint256[], bool"), [
      owner,
      stocks.map((stock) => stock.mainnetAddress),
      minimums,
      true,
    ]),
  ]);
  const salt = keccak256(stringToHex("SowmorrowVault:1.0.0:base-mainnet:launch-1"));
  const vault = getContractAddress({ opcode: "CREATE2", from: deploymentFactory, salt, bytecode: initCode });
  return {
    chainId: 8453,
    owner,
    vault,
    salt,
    initCode,
    call: { to: deploymentFactory, data: concat([salt, initCode]), value: "0x0" as const },
  };
}
