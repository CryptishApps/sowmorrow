// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { SowmorrowVault } from "../../src/SowmorrowVault.sol";
import { AuditBase } from "./AuditBase.sol";

/// Hypothesis G: the `uint64 unlockAt` parameter cannot be smuggled past the ABI decoder with
/// dirty high bits.
contract AuditCalldataTest is AuditBase {
    function test_G1_dirtyHighBitsOnUint64UnlockAtAreRejectedNotTruncated() public {
        uint256 dirty = (uint256(1) << 64) | uint256(block.timestamp + 1000);
        bytes memory payload = abi.encodePacked(
            SowmorrowVault.createGift.selector,
            uint256(uint160(address(asset))),
            uint256(uint160(recipient)),
            GIFT_AMOUNT,
            dirty,
            bytes32(0)
        );

        vm.prank(sender);
        (bool ok,) = address(vault).call(payload);
        assertFalse(ok, "dirty uint64 must not decode");
        assertEq(vault.nextGiftId(), 1);

        // A clean encoding of the same intended value is accepted.
        vm.prank(sender);
        uint256 giftId =
            vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1000), bytes32(0));
        assertEq(vault.getGift(giftId).unlockAt, uint64(block.timestamp + 1000));
    }

    /// The vault exposes no fallback, no receive, and no unknown-selector surface.
    function test_G2_noFallbackOrReceiveSurface() public {
        vm.deal(sender, 1 ether);
        vm.prank(sender);
        (bool ethOk,) = address(vault).call{ value: 1 wei }("");
        assertFalse(ethOk);

        vm.prank(sender);
        (bool unknownOk,) = address(vault).call(hex"c0ffee00");
        assertFalse(unknownOk);
    }
}
