// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script } from "forge-std/Script.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";
import { StdPrecompiles } from "base-std/StdPrecompiles.sol";
import { SowmorrowTestStockFaucet } from "../src/fixtures/SowmorrowTestStockFaucet.sol";
import { SowmorrowVault } from "../src/SowmorrowVault.sol";
import { SowmorrowTestFixtures } from "./SowmorrowTestFixtures.sol";

contract DeployTestFixtures is Script {
    error UnsupportedTestChain(uint256 chainId);
    error FixtureAddressMismatch(uint256 index, address predicted, address actual);

    uint256 public constant LOCAL_CHAIN_ID = 31337;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    string public constant LOCAL_ARTIFACT_PATH = "./deployments/local-31337.generated.json";
    string public constant SEPOLIA_ARTIFACT_PATH = "./deployments/base-sepolia-84532.generated.json";
    uint256 public constant FIXTURE_MIN_GIFT_AMOUNT_RAW = 0.01 ether;

    function run() external returns (SowmorrowVault vault, SowmorrowTestStockFaucet faucet) {
        uint256 chainId = block.chainid;
        if (chainId != LOCAL_CHAIN_ID && chainId != BASE_SEPOLIA_CHAIN_ID) {
            revert UnsupportedTestChain(chainId);
        }

        address configuredOwner;
        if (chainId == BASE_SEPOLIA_CHAIN_ID) configuredOwner = vm.envAddress("SOWMORROW_OWNER");

        SowmorrowTestFixtures.Fixture[] memory definitions = SowmorrowTestFixtures.all();
        uint256 count = definitions.length;
        address[] memory addresses = new address[](count);
        string[] memory names = new string[](count);
        string[] memory symbols = new string[](count);

        address deployer;
        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
        address owner = chainId == LOCAL_CHAIN_ID ? deployer : configuredOwner;
        for (uint256 index = 0; index < count; ++index) {
            address predicted = StdPrecompiles.B20_FACTORY
            .getB20Address(IB20Factory.B20Variant.ASSET, deployer, definitions[index].salt);
            addresses[index] = SowmorrowTestFixtures.create(definitions[index], deployer);
            if (addresses[index] != predicted) {
                revert FixtureAddressMismatch(index, predicted, addresses[index]);
            }
            names[index] = definitions[index].name;
            symbols[index] = definitions[index].symbol;
        }

        faucet = new SowmorrowTestStockFaucet(addresses);
        for (uint256 index = 0; index < count; ++index) {
            IB20(addresses[index]).grantRole(B20Constants.MINT_ROLE, address(faucet));
        }

        uint256[] memory minGiftAmountsRaw = new uint256[](count);
        for (uint256 index = 0; index < count; ++index) {
            minGiftAmountsRaw[index] = FIXTURE_MIN_GIFT_AMOUNT_RAW;
        }
        vault = new SowmorrowVault(owner, addresses, minGiftAmountsRaw, false);
        vm.stopBroadcast();

        string memory artifact = "sowmorrow-test-fixtures";
        vm.serializeUint(artifact, "chainId", chainId);
        vm.serializeUint(artifact, "simulationBlock", block.number);
        vm.serializeString(artifact, "contractVersion", vault.VERSION());
        vm.serializeAddress(artifact, "deployer", deployer);
        vm.serializeAddress(artifact, "owner", vault.owner());
        vm.serializeAddress(artifact, "vaultAddress", address(vault));
        vm.serializeAddress(artifact, "faucetAddress", address(faucet));
        vm.serializeBytes32(artifact, "runtimeBytecodeHash", keccak256(address(vault).code));
        vm.serializeBool(artifact, "startPaused", vault.creationPaused());
        vm.serializeString(artifact, "fixtureNames", names);
        vm.serializeString(artifact, "fixtureSymbols", symbols);
        string memory artifactPath = chainId == LOCAL_CHAIN_ID ? LOCAL_ARTIFACT_PATH : SEPOLIA_ARTIFACT_PATH;
        vm.writeJson(vm.serializeAddress(artifact, "fixtureAddresses", addresses), artifactPath);
    }
}
