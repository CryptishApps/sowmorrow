// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Vm } from "forge-std/Vm.sol";
import { PolicyRegistryConstants } from "base-std-test/lib/mocks/MockPolicyRegistry.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";
import { AuditBase } from "./AuditBase.sol";

/// Hypotheses F (batch semantics + gas), H (dust-gift griefing), I (memo), K (events).
contract AuditBatchGriefingEventsTest is AuditBase {
    event GiftClaimed(uint256 indexed giftId, address indexed recipient, address indexed stock, uint256 amountRaw);

    function test_F1_maxBatchOfTwentyGiftsGasIsFarBelowAnyBaseBlockLimit() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 maxBatch = vault.MAX_BATCH();
        uint256[] memory ids = new uint256[](maxBatch);
        for (uint256 i = 0; i < maxBatch; ++i) {
            ids[i] = _createGift(unlockAt);
        }
        vm.warp(unlockAt);

        vm.prank(recipient);
        uint256 gasBefore = gasleft();
        vault.claimMany(ids);
        uint256 used = gasBefore - gasleft();

        emit log_named_uint("claimMany(20) gas", used);
        assertLt(used, 3_000_000, "20-gift batch stays under 3M gas");
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT * maxBatch);
    }

    /// A gift belonging to somebody else anywhere in the batch reverts the whole batch.
    function test_F2_foreignGiftInBatchRevertsEverything() public {
        address other = makeAddr("other");
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 mine = _createGift(unlockAt);
        vm.prank(sender);
        uint256 theirs = vault.createGift(address(asset), other, GIFT_AMOUNT, unlockAt, bytes32(0));

        uint256[] memory ids = new uint256[](2);
        ids[0] = mine;
        ids[1] = theirs;
        vm.warp(unlockAt);
        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.NotGiftRecipient.selector, theirs, recipient, other));
        vault.claimMany(ids);

        assertEq(uint8(vault.getGift(mine).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(asset.balanceOf(recipient), 0);
    }

    /// Mixed stocks where one issuer blocks the recipient: the entire batch reverts, so a
    /// recipient with one compliance-blocked stock must claim the rest individually.
    function test_F3_mixedStockBatchWithOneBlockedStockRevertsAtomically() public {
        IB20Asset second = _newAsset(keccak256("audit-asset-2"), "Audit Asset Two", "AUD2", 8);
        vm.startPrank(admin);
        vault.setSupportedStock(address(second), true, DEFAULT_MIN_AMOUNT_RAW);
        second.grantRole(B20Constants.MINT_ROLE, admin);
        second.mint(sender, 1_000_000);
        vm.stopPrank();
        vm.prank(sender);
        second.approve(address(vault), type(uint256).max);

        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 openGift = _createGift(unlockAt);
        vm.prank(sender);
        uint256 blockedGift = vault.createGift(address(second), recipient, 1_000, unlockAt, bytes32(0));

        vm.prank(admin);
        second.updatePolicy(B20Constants.TRANSFER_RECEIVER_POLICY, PolicyRegistryConstants.ALWAYS_BLOCK_ID);

        uint256[] memory ids = new uint256[](2);
        ids[0] = openGift;
        ids[1] = blockedGift;
        vm.warp(unlockAt);
        vm.prank(recipient);
        vm.expectPartialRevert(IB20.PolicyForbids.selector);
        vault.claimMany(ids);
        assertEq(asset.balanceOf(recipient), 0, "the healthy gift is dragged down with it");

        uint256[] memory single = new uint256[](1);
        single[0] = openGift;
        vm.prank(recipient);
        vault.claimMany(single);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
    }

    /// Anyone can push unbounded dust gifts at any recipient. It never blocks an onchain claim,
    /// but it inflates the recipient's GiftCreated log set without bound.
    function test_H1_dustGiftFloodDoesNotBlockOnchainClaims() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 spamCount = 300;
        vm.startPrank(griefer);
        for (uint256 i = 0; i < spamCount; ++i) {
            vault.createGift(address(asset), recipient, 1, unlockAt, bytes32(0));
        }
        vm.stopPrank();

        uint256 realGift = _createGift(unlockAt);
        assertEq(realGift, spamCount + 1);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT + spamCount);

        vm.warp(unlockAt);
        vm.prank(recipient);
        uint256 gasBefore = gasleft();
        vault.claim(realGift);
        emit log_named_uint("single claim gas after 300 dust gifts", gasBefore - gasleft());
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
    }

    /// A per-stock minimum turns the same flood from free into capital-locked: every dust amount
    /// below the owner-set minimum reverts before it can consume a gift id or an event slot.
    function test_H2_perStockMinimumRejectsDustAmountsThatUsedToFloodForFree() public {
        uint256 minAmount = 1 ether;
        vm.prank(admin);
        vault.setMinGiftAmountRaw(address(asset), minAmount);

        uint64 unlockAt = uint64(block.timestamp + 1);
        vm.prank(griefer);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.GiftAmountBelowMinimum.selector, address(asset), 1, minAmount)
        );
        vault.createGift(address(asset), recipient, 1, unlockAt, bytes32(0));

        vm.prank(griefer);
        uint256 giftId = vault.createGift(address(asset), recipient, minAmount, unlockAt, bytes32(0));
        assertEq(vault.getGift(giftId).amountRaw, minAmount, "flooding now costs the real minimum per gift");
    }

    /// The memo is an opaque bytes32 on the token side: any note hash, including the maximum
    /// value, transfers and is echoed verbatim in the token's Memo event.
    function test_I1_memoIsUnconstrainedAndDeterministic() public {
        bytes32 noteHash = bytes32(type(uint256).max);
        uint64 unlockAt = uint64(block.timestamp + 1);

        bytes32 expectedDeposit = keccak256(
            abi.encode(
                keccak256("SOWMORROW_BERYL_GIFT_MEMO_V1"), block.chainid, address(vault), uint256(1), uint8(0), noteHash
            )
        );
        vm.recordLogs();
        vm.prank(sender);
        uint256 giftId = vault.createGift(address(asset), recipient, GIFT_AMOUNT, unlockAt, noteHash);
        assertEq(_findMemo(vm.getRecordedLogs()), expectedDeposit, "deposit memo");

        bytes32 expectedClaim = keccak256(
            abi.encode(
                keccak256("SOWMORROW_BERYL_GIFT_MEMO_V1"), block.chainid, address(vault), giftId, uint8(1), noteHash
            )
        );
        vm.warp(unlockAt);
        vm.recordLogs();
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(_findMemo(vm.getRecordedLogs()), expectedClaim, "claim memo");
    }

    /// GiftClaimed is emitted only after the token Transfer and the balance-delta check, so an
    /// indexer never sees a claim event for a transfer that did not happen.
    function test_K1_giftClaimedIsEmittedAfterTheTokenTransfer() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);
        vm.warp(unlockAt);

        vm.recordLogs();
        vm.prank(recipient);
        vault.claim(giftId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 transferIndex = type(uint256).max;
        uint256 claimIndex = type(uint256).max;
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        bytes32 claimTopic = keccak256("GiftClaimed(uint256,address,address,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == transferTopic && logs[i].emitter == address(asset)) transferIndex = i;
            if (logs[i].topics[0] == claimTopic && logs[i].emitter == address(vault)) claimIndex = i;
        }
        assertLt(transferIndex, claimIndex, "Transfer precedes GiftClaimed");
        assertEq(uint256(logs[claimIndex].topics[1]), giftId);
        assertEq(address(uint160(uint256(logs[claimIndex].topics[2]))), recipient);
        assertEq(address(uint160(uint256(logs[claimIndex].topics[3]))), address(asset));
        assertEq(abi.decode(logs[claimIndex].data, (uint256)), GIFT_AMOUNT);
    }

    /// Pausing creation while an approval is outstanding is a soft denial only: it never touches
    /// existing gifts and unpausing restores creation with the same allowance.
    function test_K2_creationPauseDuringPendingApprovalIsRecoverable() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt);

        vm.prank(admin);
        vault.setCreationPaused(true);
        vm.prank(sender);
        vm.expectRevert(SowmorrowVault.CreationPaused.selector);
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, unlockAt, bytes32(0));

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);

        vm.prank(admin);
        vault.setCreationPaused(false);
        vm.prank(sender);
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));
        assertEq(asset.allowance(sender, address(vault)), type(uint256).max);
    }

    function _findMemo(Vm.Log[] memory logs) private view returns (bytes32) {
        bytes32 memoTopic = keccak256("Memo(address,bytes32)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == memoTopic && logs[i].emitter == address(asset)) {
                return logs[i].topics[2];
            }
        }
        revert("no memo log");
    }
}
