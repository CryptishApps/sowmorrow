// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";
import { AuditBase } from "./AuditBase.sol";
import { CallbackProbe, CrossReentrantB20 } from "./CrossReentrantB20.sol";

/// Hypothesis C: reentrancy. Cross-function reentry is blocked, and the reference B-20 hands
/// control to nobody except the fixed policy-registry precompile.
contract AuditReentrancyTest is AuditBase {
    function _installForClaim(CrossReentrantB20.Target onTransfer)
        internal
        returns (uint256 giftId, CrossReentrantB20 hostile)
    {
        uint64 unlockAt = uint64(block.timestamp + 1);
        giftId = _createGift(unlockAt);
        vm.etch(address(asset), type(CrossReentrantB20).runtimeCode);
        hostile = CrossReentrantB20(address(asset));
        hostile.configure(
            address(vault), sender, recipient, 0, GIFT_AMOUNT, giftId, CrossReentrantB20.Target.None, onTransfer
        );
        vm.warp(unlockAt);
    }

    function _installForCreate(CrossReentrantB20.Target onTransferFrom) internal returns (CrossReentrantB20 hostile) {
        vm.etch(address(asset), type(CrossReentrantB20).runtimeCode);
        hostile = CrossReentrantB20(address(asset));
        hostile.configure(
            address(vault), sender, recipient, STARTING_BALANCE, 0, 1, onTransferFrom, CrossReentrantB20.Target.None
        );
    }

    function test_C1_claimCannotReenterClaimMany() public referenceModeOnly {
        (uint256 giftId, CrossReentrantB20 hostile) = _installForClaim(CrossReentrantB20.Target.ClaimMany);
        vm.prank(recipient);
        vault.claim(giftId);

        assertTrue(hostile.reentryAttempted());
        assertFalse(hostile.reentrySucceeded());
        assertEq(hostile.reentrySelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(hostile.balanceOf(recipient), GIFT_AMOUNT, "paid exactly once");
        assertEq(vault.totalEscrowed(address(hostile)), 0);
    }

    function test_C2_claimCannotReenterCreateGift() public referenceModeOnly {
        (uint256 giftId, CrossReentrantB20 hostile) = _installForClaim(CrossReentrantB20.Target.CreateGift);
        vm.prank(recipient);
        vault.claim(giftId);

        assertTrue(hostile.reentryAttempted());
        assertFalse(hostile.reentrySucceeded());
        assertEq(hostile.reentrySelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(vault.nextGiftId(), 2, "no extra id minted by the reentrant create");
    }

    function test_C3_claimManyCannotReenterClaim() public referenceModeOnly {
        (uint256 giftId, CrossReentrantB20 hostile) = _installForClaim(CrossReentrantB20.Target.Claim);
        uint256[] memory ids = new uint256[](1);
        ids[0] = giftId;
        vm.prank(recipient);
        vault.claimMany(ids);

        assertTrue(hostile.reentryAttempted());
        assertFalse(hostile.reentrySucceeded());
        assertEq(hostile.reentrySelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(hostile.balanceOf(recipient), GIFT_AMOUNT);
    }

    function test_C4_createGiftCannotReenterClaimOrClaimMany() public referenceModeOnly {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);

        CrossReentrantB20 hostile = _installForCreate(CrossReentrantB20.Target.Claim);
        hostile.configure(
            address(vault),
            sender,
            recipient,
            STARTING_BALANCE,
            GIFT_AMOUNT,
            giftId,
            CrossReentrantB20.Target.Claim,
            CrossReentrantB20.Target.None
        );
        vm.warp(unlockAt);

        vm.prank(sender);
        vault.createGift(address(hostile), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        assertTrue(hostile.reentryAttempted());
        assertFalse(hostile.reentrySucceeded());
        assertEq(hostile.reentrySelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Active), "not double spent");
    }

    /// The reference B-20 never calls the sender or the receiver. A contract on either side of a
    /// gift never observes a callback, so there is no ERC-777-style hook surface at all.
    function test_C5_referenceB20NeverCallsBackIntoSenderOrRecipient() public {
        CallbackProbe depositor = new CallbackProbe();
        CallbackProbe beneficiary = new CallbackProbe();

        vm.prank(sender);
        asset.transfer(address(depositor), GIFT_AMOUNT);
        depositor.approve(address(asset), address(vault));

        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId =
            depositor.createGift(address(vault), address(asset), address(beneficiary), GIFT_AMOUNT, unlockAt);
        assertFalse(depositor.touched(), "no callback to the depositor during transferFromWithMemo");

        vm.warp(unlockAt);
        beneficiary.claim(address(vault), giftId);
        assertEq(asset.balanceOf(address(beneficiary)), GIFT_AMOUNT);
        assertFalse(beneficiary.touched(), "no callback to the recipient during transferWithMemo");
    }
}
