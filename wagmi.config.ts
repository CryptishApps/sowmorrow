import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

export default defineConfig({
  out: "lib/contracts/generated.ts",
  plugins: [
    foundry({
      project: "contracts",
      exclude: ["interfaces/**"],
      include: [
        "SowmorrowVault.sol/SowmorrowVault.json",
        "IB20.sol/IB20.json",
        "IB20Asset.sol/IB20Asset.json",
      ],
      forge: { build: true, clean: false, rebuild: false },
    }),
  ],
});
