import { prepareFactoryDeployment } from "./factory-deployment";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, getAddress, http } from "viem";
import { z } from "zod";
import { base } from "viem/chains";
import { buildMainnetManifest } from "./mainnet-manifest";

async function main() {
  const { values } = parseArgs({
    options: {
      "factory-transaction": { type: "string" },
      broadcast: {
        type: "string",
        default: "contracts/broadcast/DeploySowmorrow.s.sol/8453/run-latest.json",
      },
      artifact: { type: "string", default: "contracts/out/SowmorrowVault.sol/SowmorrowVault.json" },
      out: { type: "string", default: "contracts/deployments/base-mainnet-8453.json" },
    },
  });
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL;
  const owner = process.env.SOWMORROW_OWNER;
  if (!rpcUrl || !owner)
    throw new Error("Set BASE_MAINNET_RPC_URL and SOWMORROW_OWNER in the operator environment");
  const artifact = JSON.parse(readFileSync(values.artifact!, "utf8"));
  const manifest = await buildMainnetManifest({
    client: createPublicClient({ chain: base, transport: http(rpcUrl) }),
    expectedOwner: getAddress(owner),
    ownerKind: z.enum(["safe", "smart-wallet"]).parse(process.env.SOWMORROW_OWNER_KIND ?? "safe"),
    creationCode: artifact.bytecode.object,
    runtimeCode: artifact.deployedBytecode.object,
    ...(values["factory-transaction"]
      ? {
          factoryDeployment: prepareFactoryDeployment(artifact.bytecode.object, getAddress(owner)),
          broadcast: {
            chain: 8453,
            transactions: [
              {
                hash: values["factory-transaction"],
                transactionType: "CREATE",
                contractName: "SowmorrowVault",
                contractAddress: prepareFactoryDeployment(artifact.bytecode.object, getAddress(owner)).vault,
              },
            ],
          },
        }
      : { broadcast: JSON.parse(readFileSync(values.broadcast!, "utf8")) }),
  });
  writeFileSync(values.out!, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${values.out} (verified Base mainnet deployment)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Manifest verification failed");
  process.exitCode = 1;
});
