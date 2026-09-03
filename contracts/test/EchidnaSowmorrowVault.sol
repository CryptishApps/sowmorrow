// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Vm } from "forge-std/Vm.sol";
import { StdPrecompiles } from "base-std/StdPrecompiles.sol";
import { SowmorrowVault } from "../src/SowmorrowVault.sol";

contract EchidnaFactoryStub {
    mapping(address token => bool value) private known;
    mapping(address token => bool value) private initialized;

    function configure(address token) external {
        known[token] = true;
        initialized[token] = true;
    }

    function isB20(address token) external view returns (bool) {
        return known[token];
    }

    function isB20Initialized(address token) external view returns (bool) {
        return initialized[token];
    }
}

contract EchidnaAssetStub {
    mapping(address account => uint256 amount) private balances;
    mapping(address owner => mapping(address spender => uint256 amount)) private allowances;

    function WAD_PRECISION() external pure returns (uint256) {
        return 1 ether;
    }

    function multiplier() external pure returns (uint256) {
        return 1 ether;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFromWithMemo(address from, address to, uint256 amount, bytes32) external returns (bool) {
        uint256 allowance = allowances[from][msg.sender];
        if (allowance != type(uint256).max) allowances[from][msg.sender] = allowance - amount;
        _transfer(from, to, amount);
        return true;
    }

    function transferWithMemo(address to, uint256 amount, bytes32) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balances[from] -= amount;
        balances[to] += amount;
    }
}

contract EchidnaSowmorrowVault {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ASSET_ADDRESS = 0xb200000000000000000000000000000000000001;
    uint256 private constant MAX_TRACKED_GIFTS = 32;

    struct ExpectedGift {
        uint256 id;
        address recipient;
        uint256 amountRaw;
        uint64 unlockAt;
        bytes32 noteHash;
    }

    SowmorrowVault public immutable vault;
    EchidnaAssetStub public immutable asset;

    ExpectedGift[] private expectedGifts;
    mapping(uint256 giftId => bool value) private claimed;
    bool private prematureClaimSucceeded;
    bool private unauthorizedClaimSucceeded;
    bool private unauthorizedAdminSucceeded;

    constructor() {
        EchidnaFactoryStub factoryTemplate = new EchidnaFactoryStub();
        EchidnaAssetStub assetTemplate = new EchidnaAssetStub();
        vm.etch(StdPrecompiles.B20_FACTORY_ADDRESS, address(factoryTemplate).code);
        vm.etch(ASSET_ADDRESS, address(assetTemplate).code);

        EchidnaFactoryStub(StdPrecompiles.B20_FACTORY_ADDRESS).configure(ASSET_ADDRESS);
        asset = EchidnaAssetStub(ASSET_ADDRESS);
        asset.mint(address(this), 1_000_000 ether);

        address[] memory initialStocks = new address[](1);
        initialStocks[0] = ASSET_ADDRESS;
        uint256[] memory initialMinAmounts = new uint256[](1);
        initialMinAmounts[0] = 1;
        vault = new SowmorrowVault(address(this), initialStocks, initialMinAmounts, false);
        asset.approve(address(vault), type(uint256).max);
    }

    function create(uint96 amountSeed, uint32 delaySeed, uint8 recipientSeed, bytes32 noteHash) external {
        if (expectedGifts.length >= MAX_TRACKED_GIFTS || vault.creationPaused() || !vault.supportedStock(ASSET_ADDRESS))
        {
            return;
        }
        uint256 available = asset.balanceOf(address(this));
        if (available == 0) return;
        uint256 amountRaw = uint256(amountSeed) % available + 1;
        address recipient = _recipient(recipientSeed);
        uint64 unlockAt = uint64(block.timestamp + (uint256(delaySeed) % 30 days) + 1);

        try vault.createGift(ASSET_ADDRESS, recipient, amountRaw, unlockAt, noteHash) returns (uint256 giftId) {
            expectedGifts.push(ExpectedGift(giftId, recipient, amountRaw, unlockAt, noteHash));
        } catch { }
    }

    function claim(uint8 giftSeed) external {
        uint256 count = expectedGifts.length;
        if (count == 0) return;
        ExpectedGift memory expected = expectedGifts[giftSeed % count];
        bool premature = block.timestamp < expected.unlockAt;
        vm.prank(expected.recipient);
        try vault.claim(expected.id) {
            claimed[expected.id] = true;
            if (premature) prematureClaimSucceeded = true;
        } catch { }
    }

    function claimAsWrongRecipient(uint8 giftSeed) external {
        uint256 count = expectedGifts.length;
        if (count == 0) return;
        ExpectedGift memory expected = expectedGifts[giftSeed % count];
        vm.prank(address(0xBEEF));
        try vault.claim(expected.id) {
            unauthorizedClaimSucceeded = true;
        } catch { }
    }

    function advanceTime(uint32 secondsSeed) external {
        vm.warp(block.timestamp + (uint256(secondsSeed) % 30 days) + 1);
    }

    function toggleCreationPause() external {
        vault.setCreationPaused(!vault.creationPaused());
    }

    function toggleStockSupport() external {
        bool currentlySupported = vault.supportedStock(ASSET_ADDRESS);
        vault.setSupportedStock(ASSET_ADDRESS, !currentlySupported, currentlySupported ? 0 : 1);
    }

    function sendSurplus(uint96 amountSeed) external {
        uint256 available = asset.balanceOf(address(this));
        if (available == 0) return;
        asset.transfer(address(vault), uint256(amountSeed) % available + 1);
    }

    function tryUnauthorizedAdminAction(bool pauseAction) external {
        bool currentlySupported = vault.supportedStock(ASSET_ADDRESS);
        bytes memory callData = pauseAction
            ? abi.encodeCall(SowmorrowVault.setCreationPaused, (!vault.creationPaused()))
            : abi.encodeCall(
                SowmorrowVault.setSupportedStock, (ASSET_ADDRESS, !currentlySupported, currentlySupported ? 0 : 1)
            );
        vm.prank(address(0xBEEF));
        (bool succeeded,) = address(vault).call(callData);
        if (succeeded) unauthorizedAdminSucceeded = true;
    }

    function echidna_vault_is_solvent() external view returns (bool) {
        return asset.balanceOf(address(vault)) >= vault.totalEscrowed(ASSET_ADDRESS);
    }

    function echidna_ids_are_monotonic() external view returns (bool) {
        return vault.nextGiftId() == expectedGifts.length + 1;
    }

    function echidna_liability_matches_active_gifts() external view returns (bool) {
        uint256 activeRaw = 0;
        uint256 count = expectedGifts.length;
        for (uint256 index = 0; index < count; ++index) {
            SowmorrowVault.Gift memory gift = vault.getGift(expectedGifts[index].id);
            if (gift.status == SowmorrowVault.GiftStatus.Active) activeRaw += gift.amountRaw;
        }
        return vault.totalEscrowed(ASSET_ADDRESS) == activeRaw;
    }

    function echidna_gift_identity_is_immutable_and_claim_is_one_way() external view returns (bool) {
        uint256 count = expectedGifts.length;
        for (uint256 index = 0; index < count; ++index) {
            ExpectedGift memory expected = expectedGifts[index];
            SowmorrowVault.Gift memory gift = vault.getGift(expected.id);
            if (
                gift.sender != address(this) || gift.recipient != expected.recipient || gift.stock != ASSET_ADDRESS
                    || gift.amountRaw != expected.amountRaw || gift.unlockAt != expected.unlockAt
                    || gift.noteHash != expected.noteHash
            ) return false;
            if (claimed[expected.id] && gift.status != SowmorrowVault.GiftStatus.Claimed) return false;
        }
        return true;
    }

    function echidna_authorization_holds() external view returns (bool) {
        return !unauthorizedClaimSucceeded && !unauthorizedAdminSucceeded;
    }

    function echidna_unlock_time_holds() external view returns (bool) {
        return !prematureClaimSucceeded;
    }

    function _recipient(uint8 seed) private pure returns (address) {
        return address(uint160(0x1000 + (uint256(seed) % 4)));
    }
}
