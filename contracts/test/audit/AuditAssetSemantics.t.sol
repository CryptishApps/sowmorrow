// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { MockB20Storage } from "base-std-test/lib/mocks/MockB20Storage.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";
import { StdPrecompiles } from "base-std/StdPrecompiles.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";
import { AuditBase } from "./AuditBase.sol";

/// Minimal non-factory contract that satisfies every `_validateAsset` interface probe.
contract CounterfeitAsset {
    function WAD_PRECISION() external pure returns (uint256) {
        return 1 ether;
    }

    function multiplier() external pure returns (uint256) {
        return 1 ether;
    }
}

contract AuditAssetSemanticsTest is AuditBase {
    // --- Hypothesis A: multiplier / stock-split semantics ---

    /// balanceOf and transfer are RAW units; only scaledBalanceOf/toScaledBalance apply the
    /// multiplier. A split therefore cannot move the vault's balance-delta check.
    function test_A1_balanceOfAndTransferAreRawAndUnaffectedByMultiplier() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);

        uint256 rawBefore = asset.balanceOf(address(vault));
        vm.startPrank(admin);
        asset.grantRole(B20Constants.OPERATOR_ROLE, admin);
        asset.updateMultiplier(3 ether);
        vm.stopPrank();

        assertEq(asset.balanceOf(address(vault)), rawBefore, "balanceOf must be raw");
        assertEq(asset.scaledBalanceOf(address(vault)), rawBefore * 3, "scaled view follows multiplier");

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
        assertEq(vault.totalEscrowed(address(asset)), 0);
    }

    /// Multiplier changes mid-flight in BOTH directions still claim exactly.
    function test_A2_multiplierChangeBetweenCreateAndClaimBothDirections() public {
        vm.prank(admin);
        asset.grantRole(B20Constants.OPERATOR_ROLE, admin);

        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 first = _createGift(unlockAt);
        vm.prank(admin);
        asset.updateMultiplier(0.25 ether); // reverse split
        uint256 second = _createGift(unlockAt);
        vm.prank(admin);
        asset.updateMultiplier(8 ether); // forward split

        vm.warp(unlockAt);
        uint256[] memory ids = new uint256[](2);
        ids[0] = first;
        ids[1] = second;
        vm.prank(recipient);
        vault.claimMany(ids);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT * 2, "raw payout is split-independent");
    }

    /// The economic consequence: raw payout is exact, but a reverse split can round the gift's
    /// scaled (economic) value to zero. The vault has no floor on this.
    function test_A3_reverseSplitCanRoundGiftEconomicValueToZero() public {
        vm.prank(sender);
        uint256 giftId = vault.createGift(address(asset), recipient, 0.1 ether, uint64(block.timestamp + 1), bytes32(0));

        vm.startPrank(admin);
        asset.grantRole(B20Constants.OPERATOR_ROLE, admin);
        asset.updateMultiplier(1); // 1 wei of WAD
        vm.stopPrank();

        vm.warp(block.timestamp + 1);
        vm.prank(recipient);
        vault.claim(giftId);

        assertEq(asset.balanceOf(recipient), 0.1 ether, "raw is preserved");
        assertEq(asset.scaledBalanceOf(recipient), 0, "scaled economic value rounds to zero");
    }

    /// The `multiplier != 0` allowlist check cannot be invalidated later: the token itself
    /// rejects a zero multiplier.
    function test_A4_multiplierCanNeverBecomeZeroAfterAllowlisting() public {
        vm.startPrank(admin);
        asset.grantRole(B20Constants.OPERATOR_ROLE, admin);
        vm.expectRevert(IB20Asset.InvalidMultiplier.selector);
        asset.updateMultiplier(0);
        vm.stopPrank();
        assertGt(asset.multiplier(), 0);
    }

    // --- Hypothesis J: asset validation ---

    /// Byte [10] of a factory-derived address really is the variant discriminator.
    function test_J1_addressByteTenEncodesVariant() public view {
        address assetAddr = factory.getB20Address(IB20Factory.B20Variant.ASSET, alice, keccak256("v"));
        address stableAddr = factory.getB20Address(IB20Factory.B20Variant.STABLECOIN, alice, keccak256("v"));
        assertEq(uint8(bytes20(assetAddr)[10]), uint8(IB20Factory.B20Variant.ASSET));
        assertEq(uint8(bytes20(stableAddr)[10]), uint8(IB20Factory.B20Variant.STABLECOIN));
        assertTrue(factory.isB20(assetAddr));
        assertTrue(factory.isB20(stableAddr));
    }

    /// A stablecoin cannot be allowlisted at runtime either (not just in the constructor).
    function test_J2_setSupportedStockRejectsStablecoinVariant() public {
        address stable = _createStablecoin();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockNotAsset.selector, stable));
        vault.setSupportedStock(stable, true, DEFAULT_MIN_AMOUNT_RAW);
    }

    /// `isB20` is a pure ADDRESS-PREFIX test, not a provenance test: it returns true for an
    /// address at which no token has ever been created.
    function test_J3_isB20IsPrefixOnlyAndProvesNoProvenance() public view {
        address neverCreated = address(uint160(0xB2) << 152 | uint160(0xDEADBEEF));
        assertTrue(factory.isB20(neverCreated), "prefix alone satisfies isB20");
        assertFalse(factory.isB20Initialized(neverCreated), "but not initialized");
    }

    /// Arbitrary non-factory code sitting at a B-20-shaped address passes every `_validateAsset`
    /// probe. Only the 88-bit address-prefix grind (and the owner-only allowlist) stands in the way.
    function test_J4_nonFactoryCodeAtB20ShapedAddressPassesValidation() public referenceModeOnly {
        address counterfeit = address(uint160(0xB2) << 152 | uint160(0x00C0FFEE));
        assertEq(uint8(bytes20(counterfeit)[10]), uint8(IB20Factory.B20Variant.ASSET));
        vm.etch(counterfeit, type(CounterfeitAsset).runtimeCode);
        vm.store(counterfeit, MockB20Storage.initializedSlot(), bytes32(uint256(1)));

        assertTrue(StdPrecompiles.B20_FACTORY.isB20(counterfeit));
        assertTrue(StdPrecompiles.B20_FACTORY.isB20Initialized(counterfeit));

        vm.prank(admin);
        vault.setSupportedStock(counterfeit, true, DEFAULT_MIN_AMOUNT_RAW);
        assertTrue(vault.supportedStock(counterfeit), "validator accepts non-factory code");
    }
}
