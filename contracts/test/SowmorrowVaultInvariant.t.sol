// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Vm } from "forge-std/Vm.sol";
import { B20FactoryTest } from "base-std-test/lib/B20FactoryTest.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { SowmorrowVault } from "../src/SowmorrowVault.sol";

contract ClaimActor {
    function claim(SowmorrowVault vault, uint256 giftId) external returns (bool) {
        try vault.claim(giftId) {
            return true;
        } catch {
            return false;
        }
    }
}

contract VaultHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct ExpectedGift {
        uint256 id;
        address recipient;
        uint256 amountRaw;
        uint64 unlockAt;
        bytes32 noteHash;
    }

    SowmorrowVault public immutable vault;
    IB20Asset public immutable asset;

    ClaimActor[] private recipients;
    ExpectedGift[] private expectedGifts;
    mapping(uint256 giftId => bool claimed) public everClaimed;

    uint256 public totalCreatedRaw;
    uint256 public successfulClaims;

    constructor(SowmorrowVault vault_, IB20Asset asset_) {
        vault = vault_;
        asset = asset_;
        recipients.push(new ClaimActor());
        recipients.push(new ClaimActor());
        recipients.push(new ClaimActor());
        asset_.approve(address(vault_), type(uint256).max);
    }

    function acceptVaultOwnership() external {
        vault.acceptOwnership();
    }

    function create(uint96 amountSeed, uint32 delaySeed, uint8 recipientSeed, bytes32 noteHash) external {
        if (vault.creationPaused() || !vault.supportedStock(address(asset))) return;
        uint256 available = asset.balanceOf(address(this));
        if (available == 0) return;

        uint256 amount = uint256(amountSeed) % available + 1;
        uint64 unlockAt = uint64(block.timestamp + (uint256(delaySeed) % 30 days) + 1);
        address recipient = address(recipients[recipientSeed % recipients.length]);

        try vault.createGift(address(asset), recipient, amount, unlockAt, noteHash) returns (uint256 giftId) {
            expectedGifts.push(ExpectedGift(giftId, recipient, amount, unlockAt, noteHash));
            totalCreatedRaw += amount;
        } catch { }
    }

    function claim(uint256 giftSeed) external {
        uint256 count = expectedGifts.length;
        if (count == 0) return;
        ExpectedGift memory expected = expectedGifts[giftSeed % count];
        if (recipients[_recipientIndex(expected.recipient)].claim(vault, expected.id)) {
            everClaimed[expected.id] = true;
            successfulClaims += 1;
        }
    }

    function advanceTime(uint32 secondsSeed) external {
        vm.warp(block.timestamp + (uint256(secondsSeed) % 30 days) + 1);
    }

    function toggleCreationPause() external {
        vault.setCreationPaused(!vault.creationPaused());
    }

    function toggleStockSupport() external {
        bool currentlySupported = vault.supportedStock(address(asset));
        vault.setSupportedStock(address(asset), !currentlySupported, currentlySupported ? 0 : 1);
    }

    function sendSurplus(uint96 amountSeed) external {
        uint256 available = asset.balanceOf(address(this));
        if (available == 0) return;
        uint256 amount = uint256(amountSeed) % available + 1;
        asset.transfer(address(vault), amount);
    }

    function giftCount() external view returns (uint256) {
        return expectedGifts.length;
    }

    function expectedGift(uint256 index) external view returns (ExpectedGift memory) {
        return expectedGifts[index];
    }

    function _recipientIndex(address recipient) private view returns (uint256) {
        uint256 count = recipients.length;
        for (uint256 index; index < count; ++index) {
            if (address(recipients[index]) == recipient) return index;
        }
        revert();
    }
}

contract SowmorrowVaultInvariantTest is B20FactoryTest {
    SowmorrowVault internal vault;
    IB20Asset internal asset;
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.warp(1_800_000_000);
        asset = IB20Asset(
            _createAsset(
                alice,
                keccak256("invariant-asset"),
                _assetParams("Sowmorrow Invariant Asset", "SMTI", admin, 18),
                new bytes[](0)
            )
        );

        address[] memory stocks = new address[](1);
        stocks[0] = address(asset);
        uint256[] memory minAmounts = new uint256[](1);
        minAmounts[0] = 1;
        vault = new SowmorrowVault(admin, stocks, minAmounts, false);
        handler = new VaultHandler(vault, asset);

        vm.startPrank(admin);
        asset.grantRole(B20Constants.MINT_ROLE, admin);
        asset.mint(address(handler), 1_000_000 ether);
        vault.transferOwnership(address(handler));
        vm.stopPrank();
        handler.acceptVaultOwnership();

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.create.selector;
        selectors[1] = handler.claim.selector;
        selectors[2] = handler.advanceTime.selector;
        selectors[3] = handler.toggleCreationPause.selector;
        selectors[4] = handler.toggleStockSupport.selector;
        selectors[5] = handler.sendSurplus.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    function invariant_vaultBalanceAlwaysCoversRecordedLiability() public view {
        assertGe(asset.balanceOf(address(vault)), vault.totalEscrowed(address(asset)));
    }

    function invariant_nextIdEqualsSuccessfulCreationsPlusOne() public view {
        assertEq(vault.nextGiftId(), handler.giftCount() + 1);
    }

    function invariant_giftIdentityNeverChangesAndClaimIsOneWay() public view {
        uint256 count = handler.giftCount();
        for (uint256 index; index < count; ++index) {
            VaultHandler.ExpectedGift memory expected = handler.expectedGift(index);
            SowmorrowVault.Gift memory gift = vault.getGift(expected.id);
            assertEq(gift.sender, address(handler));
            assertEq(gift.recipient, expected.recipient);
            assertEq(gift.stock, address(asset));
            assertEq(gift.amountRaw, expected.amountRaw);
            assertEq(gift.unlockAt, expected.unlockAt);
            assertEq(gift.noteHash, expected.noteHash);
            assertTrue(
                gift.status == SowmorrowVault.GiftStatus.Active || gift.status == SowmorrowVault.GiftStatus.Claimed
            );
            if (handler.everClaimed(expected.id)) {
                assertEq(uint8(gift.status), uint8(SowmorrowVault.GiftStatus.Claimed));
            }
        }
    }

    function invariant_liabilityEqualsSumOfActiveGifts() public view {
        uint256 count = handler.giftCount();
        uint256 activeRaw;
        for (uint256 index; index < count; ++index) {
            VaultHandler.ExpectedGift memory expected = handler.expectedGift(index);
            SowmorrowVault.Gift memory gift = vault.getGift(expected.id);
            if (gift.status == SowmorrowVault.GiftStatus.Active) activeRaw += gift.amountRaw;
        }
        assertEq(vault.totalEscrowed(address(asset)), activeRaw);
    }
}
