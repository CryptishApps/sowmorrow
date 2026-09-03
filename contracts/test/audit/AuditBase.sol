// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { B20FactoryTest } from "base-std-test/lib/B20FactoryTest.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { SowmorrowVault } from "../../src/SowmorrowVault.sol";

abstract contract AuditBase is B20FactoryTest {
    SowmorrowVault internal vault;
    IB20Asset internal asset;

    address internal sender = makeAddr("audit-sender");
    address internal recipient = makeAddr("audit-recipient");
    address internal griefer = makeAddr("audit-griefer");

    uint256 internal constant STARTING_BALANCE = 1_000 ether;
    uint256 internal constant GIFT_AMOUNT = 25 ether;
    uint256 internal constant DEFAULT_MIN_AMOUNT_RAW = 1;

    function setUp() public virtual override {
        super.setUp();
        vm.warp(1_800_000_000);
        asset = _newAsset(keccak256("audit-asset"), "Audit Asset", "AUD", 18);

        address[] memory initialStocks = new address[](1);
        initialStocks[0] = address(asset);
        uint256[] memory initialMinAmounts = new uint256[](1);
        initialMinAmounts[0] = DEFAULT_MIN_AMOUNT_RAW;
        vault = new SowmorrowVault(admin, initialStocks, initialMinAmounts, false);

        vm.startPrank(admin);
        asset.grantRole(B20Constants.MINT_ROLE, admin);
        asset.mint(sender, STARTING_BALANCE);
        asset.mint(griefer, STARTING_BALANCE);
        vm.stopPrank();

        vm.prank(sender);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(griefer);
        asset.approve(address(vault), type(uint256).max);
    }

    function _newAsset(bytes32 salt, string memory name_, string memory symbol_, uint8 decimals_)
        internal
        returns (IB20Asset)
    {
        return IB20Asset(_createAsset(alice, salt, _assetParams(name_, symbol_, admin, decimals_), new bytes[](0)));
    }

    function _createGift(uint64 unlockAt) internal returns (uint256) {
        vm.prank(sender);
        return vault.createGift(address(asset), recipient, GIFT_AMOUNT, unlockAt, bytes32(0));
    }

    modifier referenceModeOnly() {
        if (livePrecompiles) vm.skip(true);
        _;
    }
}
