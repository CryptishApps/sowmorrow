// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { B20FactoryTest } from "base-std-test/lib/B20FactoryTest.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { SowmorrowTestFixtures } from "../../script/SowmorrowTestFixtures.sol";
import { SowmorrowTestStockFaucet } from "../../src/fixtures/SowmorrowTestStockFaucet.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";

/// @notice The external-node lane: the same create -> warp -> claim story executed against a running
///         `base-anvil` node's real Rust B20 precompiles rather than the Solidity mocks.
/// @dev Run with `npm run contracts:test:integration`, which starts from `scripts/local/up.sh`'s node.
///      The suite refuses to pass in reference mode so a green run can never mean "mocks agreed".
contract LocalNodeIntegrationTest is B20FactoryTest {
    SowmorrowVault internal vault;
    SowmorrowTestStockFaucet internal faucet;
    address internal fixtureAddress;

    address internal sender = makeAddr("integration-sender");
    address internal recipient = makeAddr("integration-recipient");

    uint256 internal constant GIFT_AMOUNT = 7 ether;

    function setUp() public override {
        super.setUp();
        require(livePrecompiles, "integration lane requires the live Base precompiles");
        require(block.chainid == 31337, "integration lane requires the local chain");

        SowmorrowTestFixtures.Fixture memory definition = SowmorrowTestFixtures.all()[0];
        definition.salt = keccak256(abi.encodePacked(definition.salt, "integration-lane", block.number));

        vm.prank(admin);
        fixtureAddress = SowmorrowTestFixtures.create(definition, admin);

        address[] memory stocks = new address[](1);
        stocks[0] = fixtureAddress;
        faucet = new SowmorrowTestStockFaucet(stocks);
        vm.prank(admin);
        IB20(fixtureAddress).grantRole(B20Constants.MINT_ROLE, address(faucet));

        uint256[] memory minGiftAmountsRaw = new uint256[](1);
        minGiftAmountsRaw[0] = 0.01 ether;
        vault = new SowmorrowVault(admin, stocks, minGiftAmountsRaw, false);
    }

    function test_liveNode_createWarpClaimSettlesExactlyOnTheRealPrecompiles() public {
        vm.prank(sender);
        faucet.requestFixture(fixtureAddress, 100 ether);
        assertEq(IB20(fixtureAddress).balanceOf(sender), 100 ether, "faucet mint");

        vm.prank(sender);
        IB20(fixtureAddress).approve(address(vault), GIFT_AMOUNT);

        uint64 unlockAt = uint64(block.timestamp + 3 days);
        bytes32 noteHash = keccak256("a live-node note");

        vm.recordLogs();
        vm.prank(sender);
        uint256 giftId = vault.createGift(fixtureAddress, recipient, GIFT_AMOUNT, unlockAt, noteHash);

        SowmorrowVault.Gift memory gift = vault.getGift(giftId);
        assertEq(gift.sender, sender, "gift sender");
        assertEq(gift.recipient, recipient, "gift recipient");
        assertEq(gift.stock, fixtureAddress, "gift stock");
        assertEq(gift.amountRaw, GIFT_AMOUNT, "gift amount");
        assertEq(gift.unlockAt, unlockAt, "gift unlock");
        assertEq(gift.noteHash, noteHash, "gift note hash");
        assertEq(uint8(gift.status), uint8(SowmorrowVault.GiftStatus.Active), "gift active");
        assertEq(vault.totalEscrowed(fixtureAddress), GIFT_AMOUNT, "vault liability after create");
        assertEq(IB20(fixtureAddress).balanceOf(address(vault)), GIFT_AMOUNT, "vault balance after create");
        assertEq(IB20(fixtureAddress).balanceOf(sender), 100 ether - GIFT_AMOUNT, "sender balance after create");

        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.GiftStillLocked.selector, giftId, unlockAt, block.timestamp)
        );
        vm.prank(recipient);
        vault.claim(giftId);

        vm.warp(unlockAt);

        vm.expectEmit(true, true, true, true, address(vault));
        emit SowmorrowVault.GiftClaimed(giftId, recipient, fixtureAddress, GIFT_AMOUNT);
        vm.prank(recipient);
        vault.claim(giftId);

        SowmorrowVault.Gift memory claimed = vault.getGift(giftId);
        assertEq(uint8(claimed.status), uint8(SowmorrowVault.GiftStatus.Claimed), "gift claimed");
        assertEq(vault.totalEscrowed(fixtureAddress), 0, "vault liability after claim");
        assertEq(IB20(fixtureAddress).balanceOf(address(vault)), 0, "vault balance after claim");
        assertEq(IB20(fixtureAddress).balanceOf(recipient), GIFT_AMOUNT, "recipient balance after claim");
    }
}
