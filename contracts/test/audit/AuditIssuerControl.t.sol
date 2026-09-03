// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { PolicyRegistryConstants } from "base-std-test/lib/mocks/MockPolicyRegistry.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { IPolicyRegistry } from "base-std/interfaces/IPolicyRegistry.sol";
import { StdPrecompiles } from "base-std/StdPrecompiles.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";
import { AuditBase } from "./AuditBase.sol";

/// Hypothesis B: the issuer's compliance surface (policies, pause, blocked-burn) is a total
/// availability dependency for escrowed gifts. The vault has no recovery path.
contract AuditIssuerControlTest is AuditBase {
    IPolicyRegistry internal registry = StdPrecompiles.POLICY_REGISTRY;

    function _pauseTransfers() internal {
        IB20.PausableFeature[] memory features = new IB20.PausableFeature[](1);
        features[0] = IB20.PausableFeature.TRANSFER;
        vm.startPrank(admin);
        asset.grantRole(B20Constants.PAUSE_ROLE, admin);
        asset.pause(features);
        vm.stopPrank();
    }

    /// Blocking the VAULT as transfer sender freezes every gift of that stock, forever, with no
    /// partial state change. Claims never become possible again unless the issuer relents.
    function test_B1_senderPolicyBlockingVaultFreezesAllClaimsWithNoStateChange() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);

        address[] memory allowed = new address[](2);
        allowed[0] = sender;
        allowed[1] = recipient;
        vm.prank(admin);
        uint64 policy = registry.createPolicyWithAccounts(admin, IPolicyRegistry.PolicyType.ALLOWLIST, allowed);
        vm.prank(admin);
        asset.updatePolicy(B20Constants.TRANSFER_SENDER_POLICY, policy);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vm.expectPartialRevert(IB20.PolicyForbids.selector);
        vault.claim(giftId);

        // Still frozen an arbitrary time later; nothing in the vault expires the block.
        vm.warp(unlockAt + 3650 days);
        vm.prank(recipient);
        vm.expectPartialRevert(IB20.PolicyForbids.selector);
        vault.claim(giftId);

        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT);
        assertEq(asset.balanceOf(address(vault)), GIFT_AMOUNT);
    }

    /// Blocking only the RECIPIENT strands that one gift while others still claim.
    function test_B2_receiverPolicyBlockingOneRecipientStrandsOnlyThatGift() public {
        address other = makeAddr("other-recipient");
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 blockedGift = _createGift(unlockAt);
        vm.prank(sender);
        uint256 openGift = vault.createGift(address(asset), other, GIFT_AMOUNT, unlockAt, bytes32(0));

        address[] memory blocked = new address[](1);
        blocked[0] = recipient;
        vm.prank(admin);
        uint64 policy = registry.createPolicyWithAccounts(admin, IPolicyRegistry.PolicyType.BLOCKLIST, blocked);
        vm.prank(admin);
        asset.updatePolicy(B20Constants.TRANSFER_RECEIVER_POLICY, policy);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vm.expectPartialRevert(IB20.PolicyForbids.selector);
        vault.claim(blockedGift);

        vm.prank(other);
        vault.claim(openGift);
        assertEq(asset.balanceOf(other), GIFT_AMOUNT);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT, "stranded gift still fully accounted");
    }

    /// createGift uses transferFromWithMemo, so the VAULT is the transfer EXECUTOR and is subject
    /// to TRANSFER_EXECUTOR_POLICY. Blocking it disables creation entirely, atomically.
    function test_B3_executorPolicyBlockingVaultDisablesCreationAtomically() public {
        vm.prank(admin);
        asset.updatePolicy(B20Constants.TRANSFER_EXECUTOR_POLICY, PolicyRegistryConstants.ALWAYS_BLOCK_ID);

        vm.prank(sender);
        vm.expectPartialRevert(IB20.PolicyForbids.selector);
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        assertEq(vault.nextGiftId(), 1, "no id consumed");
        assertEq(vault.totalEscrowed(address(asset)), 0);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotFound.selector, 1));
        vault.getGift(1);
    }

    /// Blocking the vault as transfer RECEIVER mid-createGift reverts the whole call; the
    /// storage-write-before-transfer ordering leaves nothing behind.
    function test_B4_receiverPolicyBlockingVaultRevertsCreateGiftWithNoResidue() public {
        vm.prank(admin);
        asset.updatePolicy(B20Constants.TRANSFER_RECEIVER_POLICY, PolicyRegistryConstants.ALWAYS_BLOCK_ID);

        vm.prank(sender);
        vm.expectPartialRevert(IB20.PolicyForbids.selector);
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        assertEq(vault.nextGiftId(), 1);
        assertEq(vault.totalEscrowed(address(asset)), 0);
        assertEq(asset.balanceOf(address(vault)), 0);
    }

    /// A TRANSFER pause on the token freezes both creation and claims for its duration.
    function test_B5_transferPauseFreezesCreateAndClaimAndThawsCleanly() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);
        _pauseTransfers();

        vm.prank(sender);
        vm.expectPartialRevert(IB20.ContractPaused.selector);
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, unlockAt, bytes32(0));

        vm.warp(unlockAt);
        vm.prank(recipient);
        vm.expectPartialRevert(IB20.ContractPaused.selector);
        vault.claim(giftId);
        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Active));

        IB20.PausableFeature[] memory features = new IB20.PausableFeature[](1);
        features[0] = IB20.PausableFeature.TRANSFER;
        vm.startPrank(admin);
        asset.grantRole(B20Constants.UNPAUSE_ROLE, admin);
        asset.unpause(features);
        vm.stopPrank();

        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
    }

    /// `burnBlocked` lets the issuer seize escrow out from under the vault. totalEscrowed then
    /// permanently overstates the real balance and remaining claims race for what is left.
    function test_B6_burnBlockedSeizureBreaksSolvencyAndCreatesAClaimRace() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 first = _createGift(unlockAt);
        uint256 second = _createGift(unlockAt);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT * 2);

        address[] memory allowed = new address[](2);
        allowed[0] = sender;
        allowed[1] = recipient;
        vm.prank(admin);
        uint64 policy = registry.createPolicyWithAccounts(admin, IPolicyRegistry.PolicyType.ALLOWLIST, allowed);
        vm.startPrank(admin);
        asset.updatePolicy(B20Constants.TRANSFER_SENDER_POLICY, policy);
        asset.grantRole(B20Constants.BURN_BLOCKED_ROLE, admin);
        asset.burnBlocked(address(vault), GIFT_AMOUNT);
        asset.updatePolicy(B20Constants.TRANSFER_SENDER_POLICY, PolicyRegistryConstants.ALWAYS_ALLOW_ID);
        vm.stopPrank();

        assertEq(asset.balanceOf(address(vault)), GIFT_AMOUNT);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT * 2, "liability now exceeds assets");

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(first);

        vm.prank(recipient);
        vm.expectPartialRevert(IB20.InsufficientBalance.selector);
        vault.claim(second);

        assertEq(asset.balanceOf(address(vault)), 0);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT, "phantom liability is permanent");
        assertEq(uint8(vault.getGift(second).status), uint8(SowmorrowVault.GiftStatus.Active));
    }
}
