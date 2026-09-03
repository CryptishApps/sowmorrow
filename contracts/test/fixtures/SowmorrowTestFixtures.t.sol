// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { B20FactoryTest } from "base-std-test/lib/B20FactoryTest.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";
import { SowmorrowTestFixtures } from "../../script/SowmorrowTestFixtures.sol";
import { SowmorrowTestStockFaucet } from "../../src/fixtures/SowmorrowTestStockFaucet.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";

contract SowmorrowTestFixturesTest is B20FactoryTest {
    function setUp() public override {
        super.setUp();
        vm.chainId(31337);
        vm.warp(1_800_000_000);
    }

    function _createAll() internal returns (address[] memory created) {
        SowmorrowTestFixtures.Fixture[] memory definitions = SowmorrowTestFixtures.all();
        created = new address[](definitions.length);
        for (uint256 index = 0; index < definitions.length; ++index) {
            vm.prank(admin);
            created[index] = SowmorrowTestFixtures.create(definitions[index], admin);
        }
    }

    function test_all_definesThirteenUnmistakablyValuelessFixtures() public pure {
        SowmorrowTestFixtures.Fixture[] memory definitions = SowmorrowTestFixtures.all();
        assertEq(definitions.length, SowmorrowTestFixtures.FIXTURE_COUNT);
        assertEq(definitions.length, 13);

        for (uint256 index = 0; index < definitions.length; ++index) {
            assertEq(definitions[index].decimals, 18);
            assertTrue(bytes(definitions[index].name).length > 0);
            assertEq(
                keccak256(bytes(definitions[index].name)),
                keccak256(bytes(string.concat("Sowmorrow Test Stock ", _ordinal(index))))
            );
            assertEq(
                keccak256(bytes(definitions[index].symbol)),
                keccak256(bytes(string.concat("SMT", vm.toString(index + 1))))
            );
            for (uint256 other = 0; other < index; ++other) {
                assertNotEq(definitions[other].salt, definitions[index].salt);
                assertNotEq(keccak256(bytes(definitions[other].symbol)), keccak256(bytes(definitions[index].symbol)));
                assertNotEq(keccak256(bytes(definitions[other].name)), keccak256(bytes(definitions[index].name)));
            }
        }
    }

    function test_create_landsOnThePredictedAddressWithTheIntendedIdentity() public {
        SowmorrowTestFixtures.Fixture[] memory definitions = SowmorrowTestFixtures.all();
        address[] memory predicted = new address[](definitions.length);
        for (uint256 index = 0; index < definitions.length; ++index) {
            predicted[index] = factory.getB20Address(IB20Factory.B20Variant.ASSET, admin, definitions[index].salt);
        }

        address[] memory created = _createAll();

        for (uint256 index = 0; index < created.length; ++index) {
            address fixtureAddress = created[index];
            assertEq(fixtureAddress, predicted[index]);
            assertTrue(factory.isB20(fixtureAddress));
            assertTrue(factory.isB20Initialized(fixtureAddress));
            assertEq(uint8(bytes20(fixtureAddress)[10]), uint8(IB20Factory.B20Variant.ASSET));
            assertEq(IB20(fixtureAddress).name(), definitions[index].name);
            assertEq(IB20(fixtureAddress).symbol(), definitions[index].symbol);
            assertEq(IB20(fixtureAddress).decimals(), 18);
            assertEq(IB20Asset(fixtureAddress).WAD_PRECISION(), 1 ether);
            assertEq(IB20Asset(fixtureAddress).multiplier(), 1 ether);
        }
    }

    function test_create_grantsOnlyTheDeployerAdminAndMintRolesWithTheIntendedSupply() public {
        address[] memory created = _createAll();
        for (uint256 index = 0; index < created.length; ++index) {
            IB20 fixtureToken = IB20(created[index]);
            assertTrue(fixtureToken.hasRole(B20Constants.DEFAULT_ADMIN_ROLE, admin));
            assertTrue(fixtureToken.hasRole(B20Constants.MINT_ROLE, admin));
            assertFalse(fixtureToken.hasRole(B20Constants.MINT_ROLE, alice));
            assertFalse(fixtureToken.hasRole(B20Constants.DEFAULT_ADMIN_ROLE, alice));
            assertEq(fixtureToken.balanceOf(admin), SowmorrowTestFixtures.DEPLOYER_SUPPLY_RAW);
            assertEq(fixtureToken.totalSupply(), SowmorrowTestFixtures.DEPLOYER_SUPPLY_RAW);
        }
    }

    function test_localStackShape_vaultAcceptsEveryFixtureAndTheFaucetCanMintThem() public {
        address[] memory created = _createAll();

        SowmorrowTestStockFaucet faucet = new SowmorrowTestStockFaucet(created);
        for (uint256 index = 0; index < created.length; ++index) {
            vm.prank(admin);
            IB20(created[index]).grantRole(B20Constants.MINT_ROLE, address(faucet));
        }

        uint256[] memory minGiftAmountsRaw = new uint256[](created.length);
        for (uint256 index = 0; index < created.length; ++index) {
            minGiftAmountsRaw[index] = 0.01 ether;
        }
        SowmorrowVault vault = new SowmorrowVault(admin, created, minGiftAmountsRaw, false);
        for (uint256 index = 0; index < created.length; ++index) {
            assertTrue(vault.supportedStock(created[index]));
            assertTrue(faucet.supportedFixture(created[index]));
        }

        vm.prank(alice);
        faucet.requestFixture(created[0], 5 ether);
        assertEq(IB20(created[0]).balanceOf(alice), 5 ether);
    }

    function _ordinal(uint256 index) private pure returns (string memory) {
        string[13] memory ordinals = [
            "One",
            "Two",
            "Three",
            "Four",
            "Five",
            "Six",
            "Seven",
            "Eight",
            "Nine",
            "Ten",
            "Eleven",
            "Twelve",
            "Thirteen"
        ];
        return ordinals[index];
    }
}
