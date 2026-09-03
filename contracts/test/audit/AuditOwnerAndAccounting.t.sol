// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";
import { AuditBase } from "./AuditBase.sol";
import { InertRecipient } from "./CrossReentrantB20.sol";

contract BrokenAsset { }

/// Hypotheses D (owner powers) and E (accounting).
contract AuditOwnerAndAccountingTest is AuditBase {
    // --- D: owner powers ---

    /// Every owner-reachable mutation, exercised back to back, leaves escrow and the gift record
    /// byte-identical.
    function test_D1_fullOwnerSurfaceCannotTouchEscrowOrGiftRecord() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);
        SowmorrowVault.Gift memory before = vault.getGift(giftId);

        vm.startPrank(admin);
        vault.setCreationPaused(true);
        vault.setCreationPaused(false);
        vault.setSupportedStock(address(asset), false, 0);
        vault.setSupportedStock(address(asset), true, DEFAULT_MIN_AMOUNT_RAW);
        vault.transferOwnership(makeAddr("next-owner"));
        vm.expectRevert(SowmorrowVault.OwnershipRenunciationDisabled.selector);
        vault.renounceOwnership();
        vm.stopPrank();

        SowmorrowVault.Gift memory afterGift = vault.getGift(giftId);
        assertEq(keccak256(abi.encode(before)), keccak256(abi.encode(afterGift)), "gift record immutable");
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT);
        assertEq(asset.balanceOf(address(vault)), GIFT_AMOUNT);
        assertEq(asset.balanceOf(admin), 0, "owner cannot pay itself");

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
    }

    /// Re-adding a previously removed stock re-runs `_validateAsset`; a stock whose code stopped
    /// answering the asset interface cannot be re-allowlisted.
    function test_D2_reAddingAStockRevalidatesTheAsset() public referenceModeOnly {
        vm.prank(admin);
        vault.setSupportedStock(address(asset), false, 0);

        vm.etch(address(asset), type(BrokenAsset).runtimeCode);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockAssetInterfaceInvalid.selector, address(asset)));
        vault.setSupportedStock(address(asset), true, DEFAULT_MIN_AMOUNT_RAW);
    }

    /// `transferOwnership(address(0))` only clears the pending owner; it is not a back-door
    /// renounce and the incumbent keeps full control.
    function test_D3_transferOwnershipToZeroIsNotABackdoorRenounce() public {
        address heir = makeAddr("heir");
        vm.prank(admin);
        vault.transferOwnership(heir);
        assertEq(vault.pendingOwner(), heir);

        vm.prank(admin);
        vault.transferOwnership(address(0));
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vault.owner(), admin);

        vm.prank(heir);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, heir));
        vault.acceptOwnership();

        vm.prank(admin);
        vault.setCreationPaused(true);
        assertTrue(vault.creationPaused());
    }

    /// A pending owner has no authority before acceptance, and the old owner loses it after.
    function test_D4_pendingOwnerHasNoAuthorityUntilAcceptance() public {
        address heir = makeAddr("heir");
        vm.prank(admin);
        vault.transferOwnership(heir);

        vm.prank(heir);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, heir));
        vault.setCreationPaused(true);

        vm.prank(heir);
        vault.acceptOwnership();
        assertEq(vault.owner(), heir);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vault.setCreationPaused(true);
    }

    /// renounceOwnership reverts for everyone, including non-owners (it is `pure override`, so the
    /// onlyOwner check is gone; the revert is unconditional).
    function test_D5_renounceOwnershipRevertsForAnyCaller() public {
        vm.prank(griefer);
        vm.expectRevert(SowmorrowVault.OwnershipRenunciationDisabled.selector);
        vault.renounceOwnership();
    }

    // --- E: accounting ---

    /// The vault itself and the zero address can neither be allowlisted nor gifted.
    function test_E1_vaultAndZeroAddressCannotBeStock() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockNotB20.selector, address(vault)));
        vault.setSupportedStock(address(vault), true, DEFAULT_MIN_AMOUNT_RAW);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockNotB20.selector, address(0)));
        vault.setSupportedStock(address(0), true, DEFAULT_MIN_AMOUNT_RAW);
        vm.stopPrank();

        vm.startPrank(sender);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.UnsupportedStock.selector, address(vault)));
        vault.createGift(address(vault), recipient, 1, uint64(block.timestamp + 1), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.UnsupportedStock.selector, address(0)));
        vault.createGift(address(0), recipient, 1, uint64(block.timestamp + 1), bytes32(0));
        vm.stopPrank();
    }

    /// Self-gifting is permitted and behaves as a personal time lock.
    function test_E2_selfGiftIsAllowedAndClaimable() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        vm.prank(sender);
        uint256 giftId = vault.createGift(address(asset), sender, GIFT_AMOUNT, unlockAt, bytes32(0));

        vm.warp(unlockAt);
        vm.prank(sender);
        vault.claim(giftId);
        assertEq(asset.balanceOf(sender), STARTING_BALANCE);
    }

    /// A gift to a contract that cannot originate a `claim` call is permanently unrecoverable:
    /// there is no cancel, no reassignment, and no rescue.
    function test_E3_giftToAContractThatCannotClaimIsPermanentlyLocked() public {
        InertRecipient inert = new InertRecipient();
        uint64 unlockAt = uint64(block.timestamp + 1);
        vm.prank(sender);
        uint256 giftId = vault.createGift(address(asset), address(inert), GIFT_AMOUNT, unlockAt, bytes32(0));

        vm.warp(unlockAt + 3650 days);
        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.NotGiftRecipient.selector, giftId, sender, address(inert))
        );
        vault.claim(giftId);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.NotGiftRecipient.selector, giftId, admin, address(inert)));
        vault.claim(giftId);

        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT, "locked forever");
    }

    /// Unlock boundaries: `now` rejected, `now + 1` accepted and claimable exactly at that second,
    /// and `type(uint64).max` is accepted without truncation (and is therefore never claimable in
    /// any realistic horizon).
    function test_E4_unlockBoundaries() public {
        vm.startPrank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.UnlockNotInFuture.selector, uint64(block.timestamp), block.timestamp)
        );
        vault.createGift(address(asset), recipient, 1, uint64(block.timestamp), bytes32(0));

        uint64 soon = uint64(block.timestamp + 1);
        uint256 nearGift = vault.createGift(address(asset), recipient, 1, soon, bytes32(0));
        uint256 farGift = vault.createGift(address(asset), recipient, 1, type(uint64).max, bytes32(0));
        vm.stopPrank();

        assertEq(vault.getGift(farGift).unlockAt, type(uint64).max, "no uint64 truncation");

        vm.warp(soon - 1);
        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.GiftStillLocked.selector, nearGift, soon, block.timestamp)
        );
        vault.claim(nearGift);

        vm.warp(soon);
        vm.prank(recipient);
        vault.claim(nearGift);

        vm.warp(uint256(type(uint64).max) - 1);
        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.GiftStillLocked.selector, farGift, type(uint64).max, block.timestamp)
        );
        vault.claim(farGift);

        vm.warp(uint256(type(uint64).max));
        vm.prank(recipient);
        vault.claim(farGift);
    }

    /// totalEscrowed cannot be driven below the live liability: a second claim, a foreign
    /// caller's claim, and a claim of a nonexistent id all revert before the decrement.
    function test_E5_totalEscrowedCannotUnderflow() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);
        vm.warp(unlockAt);

        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(vault.totalEscrowed(address(asset)), 0);

        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotActive.selector, giftId));
        vault.claim(giftId);

        vm.prank(griefer);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotFound.selector, 999));
        vault.claim(999);

        assertEq(vault.totalEscrowed(address(asset)), 0);
    }

    /// Retiring a stock changes neither the recorded liability nor the ability to claim, and the
    /// liability tracks the retired stock's own key.
    function test_E6_retiredStockKeepsItsLiabilityAndClaimPath() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);

        vm.prank(admin);
        vault.setSupportedStock(address(asset), false, 0);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(vault.totalEscrowed(address(asset)), 0);
        assertFalse(vault.supportedStock(address(asset)));
    }

    /// nextGiftId is strictly monotonic across senders and is never reused after a failed create.
    function test_E7_nextGiftIdIsMonotonicAndNeverReused() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        assertEq(vault.nextGiftId(), 1);
        uint256 a = _createGift(unlockAt);
        vm.prank(griefer);
        uint256 b = vault.createGift(address(asset), recipient, 1, unlockAt, bytes32(0));
        assertEq(a, 1);
        assertEq(b, 2);

        vm.prank(sender);
        vm.expectRevert(SowmorrowVault.ZeroAmount.selector);
        vault.createGift(address(asset), recipient, 0, unlockAt, bytes32(0));
        assertEq(vault.nextGiftId(), 3, "failed create consumes no id");

        uint256 c = _createGift(unlockAt);
        assertEq(c, 3);
    }
}
