// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { EchidnaSowmorrowVault } from "./EchidnaSowmorrowVault.sol";

contract EchidnaHarnessTest is Test {
    EchidnaSowmorrowVault private harness;

    function setUp() external {
        harness = new EchidnaSowmorrowVault();
    }

    function test_unauthorizedCallerCannotPauseCreation() external {
        harness.tryUnauthorizedAdminAction(true);

        assertTrue(harness.echidna_authorization_holds());
    }

    function test_unauthorizedCallerCannotChangeStockSupport() external {
        harness.tryUnauthorizedAdminAction(false);

        assertTrue(harness.echidna_authorization_holds());
    }
}
