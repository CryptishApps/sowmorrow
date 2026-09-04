// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { B20FactoryTest } from "base-std-test/lib/B20FactoryTest.sol";
import { DeployTestFixtures } from "../../script/DeployTestFixtures.s.sol";
import { SowmorrowTestStockFaucet } from "../../src/fixtures/SowmorrowTestStockFaucet.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";

contract DeployTestFixturesTest is B20FactoryTest {
    function test_run_acceptsBaseSepoliaAndUsesTheConfiguredOwner() public {
        vm.chainId(84532);
        address configuredOwner = makeAddr("sepolia-owner");
        vm.setEnv("SOWMORROW_OWNER", vm.toString(configuredOwner));

        (SowmorrowVault vault, SowmorrowTestStockFaucet faucet) = (new DeployTestFixtures()).run();

        assertEq(vault.owner(), configuredOwner);
        assertFalse(vault.creationPaused());
        assertEq(faucet.fixtureCount(), 13);
        for (uint256 index = 0; index < faucet.fixtureCount(); ++index) {
            assertTrue(vault.supportedStock(faucet.fixtureAt(index)));
        }
    }
}
