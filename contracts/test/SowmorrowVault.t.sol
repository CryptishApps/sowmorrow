// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { B20FactoryTest } from "base-std-test/lib/B20FactoryTest.sol";
import { MockPolicyRegistry, PolicyRegistryConstants } from "base-std-test/lib/mocks/MockPolicyRegistry.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";
import { SowmorrowVault } from "../src/SowmorrowVault.sol";
import {
    AdversarialB20,
    AssetProbe,
    EmptyAssetProbe,
    ForceEther,
    MultiplierRevertProbe
} from "./mocks/AdversarialB20.sol";

contract SowmorrowVaultTest is B20FactoryTest {
    SowmorrowVault internal vault;
    IB20Asset internal asset;

    address internal sender = makeAddr("sender");
    address internal recipient = makeAddr("recipient");
    uint256 internal constant STARTING_BALANCE = 1_000 ether;
    uint256 internal constant GIFT_AMOUNT = 25 ether;
    uint256 internal constant DEFAULT_MIN_AMOUNT_RAW = 1;

    function setUp() public override {
        super.setUp();
        vm.warp(1_800_000_000);
        asset = _newAsset(keccak256("primary-asset"), "Sowmorrow Test Asset One", "SMT1", 18);

        address[] memory initialStocks = new address[](1);
        initialStocks[0] = address(asset);
        vault = new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);

        vm.prank(admin);
        asset.grantRole(B20Constants.MINT_ROLE, admin);
        vm.prank(admin);
        asset.mint(sender, STARTING_BALANCE);
        vm.prank(sender);
        asset.approve(address(vault), type(uint256).max);
    }

    function test_constructor_setsVersionOwnerStockAndPauseState() public view {
        assertEq(vault.VERSION(), "1.0.0");
        assertEq(vault.MAX_BATCH(), 20);
        assertEq(vault.nextGiftId(), 1);
        assertEq(vault.owner(), admin);
        assertTrue(vault.supportedStock(address(asset)));
        assertFalse(vault.creationPaused());
    }

    function test_constructor_revertsForZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SowmorrowVault(address(0), new address[](0), new uint256[](0), false);
    }

    function test_constructor_revertsForMismatchedStockAndMinAmountArrays() public {
        address[] memory initialStocks = new address[](2);
        initialStocks[0] = address(asset);
        initialStocks[1] = makeAddr("second-stock");

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.InitialStocksMinAmountsLengthMismatch.selector, 2, 1));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsForDuplicateStock() public {
        address[] memory initialStocks = new address[](2);
        initialStocks[0] = address(asset);
        initialStocks[1] = address(asset);

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockSupportUnchanged.selector, address(asset), true));
        new SowmorrowVault(admin, initialStocks, _repeatedMinAmount(DEFAULT_MIN_AMOUNT_RAW, 2), false);
    }

    function test_constructor_revertsForOrdinaryAddress() public {
        address ordinaryAddress = makeAddr("ordinary-address");
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = ordinaryAddress;

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockNotB20.selector, ordinaryAddress));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsForUninitializedB20Address() public {
        address uninitialized =
            factory.getB20Address(IB20Factory.B20Variant.ASSET, address(this), keccak256("uninitialized"));
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = uninitialized;

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockNotInitialized.selector, uninitialized));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsForStablecoinVariant() public {
        address stablecoin = _createStablecoin();
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = stablecoin;

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockNotAsset.selector, stablecoin));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsForWrongAssetPrecision() public referenceModeOnly {
        IB20Asset candidate = _newAsset(keccak256("wrong-precision"), "Wrong Precision", "WRNG", 18);
        vm.etch(address(candidate), type(AssetProbe).runtimeCode);
        AssetProbe(address(candidate)).setValues(2 ether, 1 ether);
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = address(candidate);

        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.StockPrecisionInvalid.selector, address(candidate), 2 ether)
        );
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsForZeroAssetMultiplier() public referenceModeOnly {
        IB20Asset candidate = _newAsset(keccak256("zero-multiplier"), "Zero Multiplier", "ZERO", 18);
        vm.etch(address(candidate), type(AssetProbe).runtimeCode);
        AssetProbe(address(candidate)).setValues(1 ether, 0);
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = address(candidate);

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockMultiplierInvalid.selector, address(candidate)));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsForMalformedAssetInterface() public referenceModeOnly {
        IB20Asset candidate = _newAsset(keccak256("malformed-interface"), "Malformed", "BAD", 18);
        vm.etch(address(candidate), type(EmptyAssetProbe).runtimeCode);
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = address(candidate);

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockAssetInterfaceInvalid.selector, address(candidate)));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsWhenMultiplierSelectorFails() public referenceModeOnly {
        IB20Asset candidate = _newAsset(keccak256("bad-multiplier-call"), "Bad Multiplier", "BADM", 18);
        vm.etch(address(candidate), type(MultiplierRevertProbe).runtimeCode);
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = address(candidate);

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockAssetInterfaceInvalid.selector, address(candidate)));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(DEFAULT_MIN_AMOUNT_RAW), false);
    }

    function test_constructor_revertsForZeroInitialMinAmount() public {
        address[] memory initialStocks = new address[](1);
        initialStocks[0] = address(asset);

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.MinGiftAmountZero.selector, address(asset)));
        new SowmorrowVault(admin, initialStocks, _singleMinAmount(0), false);
    }

    function test_constructor_canStartPaused() public {
        SowmorrowVault pausedVault = new SowmorrowVault(admin, new address[](0), new uint256[](0), true);
        assertTrue(pausedVault.creationPaused());
    }

    function test_setSupportedStock_isOwnerOnlyAndRejectsNoOp() public {
        IB20Asset secondAsset = _newAsset(keccak256("second-asset"), "Sowmorrow Test Asset Two", "SMT2", 8);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vault.setSupportedStock(address(secondAsset), true, DEFAULT_MIN_AMOUNT_RAW);

        vm.prank(admin);
        vault.setSupportedStock(address(secondAsset), true, DEFAULT_MIN_AMOUNT_RAW);
        assertTrue(vault.supportedStock(address(secondAsset)));
        assertEq(vault.minGiftAmountRaw(address(secondAsset)), DEFAULT_MIN_AMOUNT_RAW);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.StockSupportUnchanged.selector, address(secondAsset), true)
        );
        vault.setSupportedStock(address(secondAsset), true, DEFAULT_MIN_AMOUNT_RAW);
    }

    function test_setSupportedStock_rejectsDisablingAlreadyDisabledAddress() public {
        address disabled = makeAddr("disabled");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.StockSupportUnchanged.selector, disabled, false));
        vault.setSupportedStock(disabled, false, 0);
    }

    function test_setSupportedStock_enablingRejectsZeroMinimum() public {
        IB20Asset secondAsset = _newAsset(keccak256("zero-min-asset"), "Sowmorrow Test Asset Zero Min", "SMTZ", 18);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.MinGiftAmountZero.selector, address(secondAsset)));
        vault.setSupportedStock(address(secondAsset), true, 0);
    }

    function test_setSupportedStock_enablingRejectsMinimumAboveCap() public {
        IB20Asset secondAsset = _newAsset(keccak256("cap-min-asset"), "Sowmorrow Test Asset Cap Min", "SMTC", 18);
        uint256 cap = vault.MAX_MIN_GIFT_AMOUNT_RAW();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowVault.MinGiftAmountExceedsMaximum.selector, address(secondAsset), cap + 1, cap
            )
        );
        vault.setSupportedStock(address(secondAsset), true, cap + 1);
    }

    function test_setSupportedStock_disablingRejectsNonZeroMinimum() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.MinGiftAmountMustBeZeroToDisable.selector, address(asset), 1)
        );
        vault.setSupportedStock(address(asset), false, 1);
    }

    function test_setSupportedStock_disablingClearsMinimum() public {
        assertEq(vault.minGiftAmountRaw(address(asset)), DEFAULT_MIN_AMOUNT_RAW);
        vm.prank(admin);
        vault.setSupportedStock(address(asset), false, 0);
        assertEq(vault.minGiftAmountRaw(address(asset)), 0);
    }

    function test_setSupportedStock_reEnablingRevalidatesAssetAndRequiresFreshMinimum() public {
        vm.prank(admin);
        vault.setSupportedStock(address(asset), false, 0);
        assertEq(vault.minGiftAmountRaw(address(asset)), 0);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.MinGiftAmountZero.selector, address(asset)));
        vault.setSupportedStock(address(asset), true, 0);

        vm.prank(admin);
        vault.setSupportedStock(address(asset), true, 3 ether);
        assertTrue(vault.supportedStock(address(asset)));
        assertEq(vault.minGiftAmountRaw(address(asset)), 3 ether);
    }

    function test_setCreationPaused_isOwnerOnlyAndRejectsNoOp() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vault.setCreationPaused(true);

        vm.prank(admin);
        vault.setCreationPaused(true);
        assertTrue(vault.creationPaused());

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.CreationPauseUnchanged.selector, true));
        vault.setCreationPaused(true);
    }

    function test_ownershipTransfer_requiresPendingOwnerAcceptance() public {
        vm.prank(admin);
        vault.transferOwnership(bob);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vault.setCreationPaused(true);

        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);

        vm.prank(bob);
        vault.setCreationPaused(true);
        assertTrue(vault.creationPaused());
    }

    function test_renounceOwnership_alwaysReverts() public {
        vm.prank(admin);
        vm.expectRevert(SowmorrowVault.OwnershipRenunciationDisabled.selector);
        vault.renounceOwnership();
    }

    function test_createGift_transfersRawUnitsAndStoresImmutableGift() public {
        uint64 unlockAt = uint64(block.timestamp + 30 days);
        bytes32 noteHash = keccak256("a note");
        bytes32 memo = _memo(1, 0, noteHash);

        vm.expectEmit(true, true, false, true, address(asset));
        emit IB20.Transfer(sender, address(vault), GIFT_AMOUNT);
        vm.expectEmit(true, true, false, true, address(asset));
        emit IB20.Memo(address(vault), memo);
        vm.expectEmit(true, true, true, true, address(vault));
        emit SowmorrowVault.GiftCreated(1, sender, recipient, address(asset), GIFT_AMOUNT, unlockAt, noteHash);

        uint256 giftId = _createGift(unlockAt, noteHash);
        SowmorrowVault.Gift memory gift = vault.getGift(giftId);

        assertEq(giftId, 1);
        assertEq(gift.sender, sender);
        assertEq(gift.recipient, recipient);
        assertEq(gift.stock, address(asset));
        assertEq(gift.amountRaw, GIFT_AMOUNT);
        assertEq(gift.unlockAt, unlockAt);
        assertEq(uint8(gift.status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(gift.noteHash, noteHash);
        assertEq(vault.nextGiftId(), 2);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT);
        assertEq(asset.balanceOf(address(vault)), GIFT_AMOUNT);
    }

    function test_createGift_assignsMonotonicNonzeroIds() public {
        uint64 unlockAt = uint64(block.timestamp + 1 days);
        assertEq(_createGift(unlockAt, bytes32(0)), 1);
        assertEq(_createGift(unlockAt, bytes32(0)), 2);
        assertEq(vault.nextGiftId(), 3);
    }

    function test_createGift_revertsWhenPaused() public {
        vm.prank(admin);
        vault.setCreationPaused(true);

        vm.prank(sender);
        vm.expectRevert(SowmorrowVault.CreationPaused.selector);
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));
    }

    function test_createGift_revertsForUnsupportedStock() public {
        vm.prank(admin);
        vault.setSupportedStock(address(asset), false, 0);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.UnsupportedStock.selector, address(asset)));
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));
    }

    function test_createGift_revertsForInvalidInputs() public {
        uint64 unlockAt = uint64(block.timestamp + 1);

        vm.startPrank(sender);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.InvalidRecipient.selector, address(0)));
        vault.createGift(address(asset), address(0), GIFT_AMOUNT, unlockAt, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.InvalidRecipient.selector, address(vault)));
        vault.createGift(address(asset), address(vault), GIFT_AMOUNT, unlockAt, bytes32(0));

        vm.expectRevert(SowmorrowVault.ZeroAmount.selector);
        vault.createGift(address(asset), recipient, 0, unlockAt, bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.UnlockNotInFuture.selector, uint64(block.timestamp), block.timestamp)
        );
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp), bytes32(0));
        vm.stopPrank();
    }

    function test_createGift_failedTransferRollsBackIdGiftAndLiability() public {
        vm.prank(sender);
        asset.approve(address(vault), 0);

        vm.prank(sender);
        vm.expectRevert();
        vault.createGift(address(asset), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1 days), bytes32(0));

        assertEq(vault.nextGiftId(), 1);
        assertEq(vault.totalEscrowed(address(asset)), 0);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotFound.selector, 1));
        vault.getGift(1);
    }

    function test_createGift_falseReturnRollsBackState() public referenceModeOnly {
        AdversarialB20 hostile = _installAdversarialForCreate(AdversarialB20.Mode.ReturnFalse);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.TokenTransferFailed.selector, address(hostile)));
        vault.createGift(address(hostile), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        _assertFailedCreateRollback(address(hostile));
    }

    function test_createGift_underCreditRollsBackState() public referenceModeOnly {
        AdversarialB20 hostile = _installAdversarialForCreate(AdversarialB20.Mode.UnderTransfer);

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowVault.UnexpectedTokenBalanceDelta.selector, address(hostile), GIFT_AMOUNT, 0, GIFT_AMOUNT - 1
            )
        );
        vault.createGift(address(hostile), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        _assertFailedCreateRollback(address(hostile));
    }

    function test_createGift_overCreditRollsBackState() public referenceModeOnly {
        AdversarialB20 hostile = _installAdversarialForCreate(AdversarialB20.Mode.OverTransfer);

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowVault.UnexpectedTokenBalanceDelta.selector, address(hostile), GIFT_AMOUNT, 0, GIFT_AMOUNT + 1
            )
        );
        vault.createGift(address(hostile), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        _assertFailedCreateRollback(address(hostile));
    }

    function test_createGift_emptyReturnDataRollsBackState() public referenceModeOnly {
        AdversarialB20 hostile = _installAdversarialForCreate(AdversarialB20.Mode.EmptyReturn);

        vm.prank(sender);
        vm.expectRevert();
        vault.createGift(address(hostile), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        _assertFailedCreateRollback(address(hostile));
    }

    function test_createGift_reentrantCallbackIsBlockedWithoutBreakingOuterTransfer() public referenceModeOnly {
        AdversarialB20 hostile = _installAdversarialForCreate(AdversarialB20.Mode.Reenter);

        vm.prank(sender);
        uint256 giftId =
            vault.createGift(address(hostile), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        assertEq(giftId, 1);
        assertFalse(hostile.lastReentrySucceeded());
        assertEq(hostile.lastReentrySelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(vault.totalEscrowed(address(hostile)), GIFT_AMOUNT);
    }

    function test_createGift_balanceReadFailureCannotConsumeId() public referenceModeOnly {
        AdversarialB20 hostile = _installAdversarialForCreate(AdversarialB20.Mode.RevertBalance);

        vm.prank(sender);
        vm.expectRevert(AdversarialB20.BalanceReadFailed.selector);
        vault.createGift(address(hostile), recipient, GIFT_AMOUNT, uint64(block.timestamp + 1), bytes32(0));

        _assertFailedCreateRollback(address(hostile));
    }

    function test_claim_onlyRecipientAtOrAfterUnlockReceivesExactRawAmount() public {
        uint64 unlockAt = uint64(block.timestamp + 30 days);
        uint256 giftId = _createGift(unlockAt, bytes32(0));

        vm.warp(unlockAt - 1);
        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftStillLocked.selector, giftId, unlockAt, unlockAt - 1));
        vault.claim(giftId);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);

        SowmorrowVault.Gift memory gift = vault.getGift(giftId);
        assertEq(uint8(gift.status), uint8(SowmorrowVault.GiftStatus.Claimed));
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
        assertEq(asset.balanceOf(address(vault)), 0);
        assertEq(vault.totalEscrowed(address(asset)), 0);
    }

    function test_claim_revertsForMissingInactiveOrWrongRecipient() public {
        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotFound.selector, 99));
        vault.claim(99);

        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt, bytes32(0));
        vm.warp(unlockAt);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.NotGiftRecipient.selector, giftId, attacker, recipient));
        vault.claim(giftId);

        vm.prank(recipient);
        vault.claim(giftId);

        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotActive.selector, giftId));
        vault.claim(giftId);
    }

    function test_claim_remainsOpenWhenCreationPausedAndStockRetired() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt, bytes32(0));

        vm.startPrank(admin);
        vault.setSupportedStock(address(asset), false, 0);
        vault.setCreationPaused(true);
        vm.stopPrank();

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
    }

    function test_claim_policyFailureRollsBackStatusAndLiability() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt, bytes32(0));

        vm.prank(admin);
        asset.updatePolicy(B20Constants.TRANSFER_RECEIVER_POLICY, PolicyRegistryConstants.ALWAYS_BLOCK_ID);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vm.expectPartialRevert(IB20.PolicyForbids.selector);
        vault.claim(giftId);

        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT);
        assertEq(asset.balanceOf(address(vault)), GIFT_AMOUNT);
    }

    function test_claim_multiplierChangeDoesNotChangeRawPayout() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt, bytes32(0));

        vm.startPrank(admin);
        asset.grantRole(B20Constants.OPERATOR_ROLE, admin);
        asset.updateMultiplier(2 ether);
        vm.stopPrank();

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
        assertEq(asset.scaledBalanceOf(recipient), GIFT_AMOUNT * 2);
    }

    function test_claim_falseReturnRollsBackState() public referenceModeOnly {
        (uint256 giftId, AdversarialB20 hostile) = _installAdversarialForClaim(AdversarialB20.Mode.ReturnFalse);

        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.TokenTransferFailed.selector, address(hostile)));
        vault.claim(giftId);

        _assertFailedClaimRollback(giftId, address(hostile));
    }

    function test_claim_underDebitRollsBackState() public referenceModeOnly {
        (uint256 giftId, AdversarialB20 hostile) = _installAdversarialForClaim(AdversarialB20.Mode.UnderTransfer);

        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowVault.UnexpectedTokenBalanceDelta.selector, address(hostile), GIFT_AMOUNT, GIFT_AMOUNT, 1
            )
        );
        vault.claim(giftId);

        _assertFailedClaimRollback(giftId, address(hostile));
    }

    function test_claim_overDebitRollsBackState() public referenceModeOnly {
        (uint256 giftId, AdversarialB20 hostile) = _installAdversarialForClaim(AdversarialB20.Mode.OverTransfer);

        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowVault.UnexpectedTokenBalanceDelta.selector,
                address(hostile),
                GIFT_AMOUNT,
                GIFT_AMOUNT,
                GIFT_AMOUNT + 1
            )
        );
        vault.claim(giftId);

        _assertFailedClaimRollback(giftId, address(hostile));
    }

    function test_claim_emptyReturnDataRollsBackState() public referenceModeOnly {
        (uint256 giftId, AdversarialB20 hostile) = _installAdversarialForClaim(AdversarialB20.Mode.EmptyReturn);

        vm.prank(recipient);
        vm.expectRevert();
        vault.claim(giftId);

        _assertFailedClaimRollback(giftId, address(hostile));
    }

    function test_claim_reentrantCallbackIsBlockedWithoutBreakingOuterTransfer() public referenceModeOnly {
        (uint256 giftId, AdversarialB20 hostile) = _installAdversarialForClaim(AdversarialB20.Mode.Reenter);

        vm.prank(recipient);
        vault.claim(giftId);

        assertFalse(hostile.lastReentrySucceeded());
        assertEq(hostile.lastReentrySelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(hostile.balanceOf(recipient), GIFT_AMOUNT);
        assertEq(vault.totalEscrowed(address(hostile)), 0);
    }

    function test_claim_balanceReadFailureLeavesGiftActive() public referenceModeOnly {
        (uint256 giftId, AdversarialB20 hostile) = _installAdversarialForClaim(AdversarialB20.Mode.RevertBalance);

        vm.prank(recipient);
        vm.expectRevert(AdversarialB20.BalanceReadFailed.selector);
        vault.claim(giftId);

        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(vault.totalEscrowed(address(hostile)), GIFT_AMOUNT);
    }

    function test_claimMany_rejectsEmptyAndOversizedBatches() public {
        vm.prank(recipient);
        vm.expectRevert(SowmorrowVault.EmptyBatch.selector);
        vault.claimMany(new uint256[](0));

        uint256[] memory oversized = new uint256[](vault.MAX_BATCH() + 1);
        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.BatchTooLarge.selector, oversized.length, vault.MAX_BATCH())
        );
        vault.claimMany(oversized);
    }

    function test_claimMany_claimsMixedAssetsAtomicallyInCalldataOrder() public {
        IB20Asset secondAsset = _newAsset(keccak256("batch-asset"), "Sowmorrow Test Asset Two", "SMT2", 8);
        vm.prank(admin);
        vault.setSupportedStock(address(secondAsset), true, DEFAULT_MIN_AMOUNT_RAW);
        vm.prank(admin);
        secondAsset.grantRole(B20Constants.MINT_ROLE, admin);
        vm.prank(admin);
        secondAsset.mint(sender, 500_000_000);
        vm.prank(sender);
        secondAsset.approve(address(vault), type(uint256).max);

        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 first = _createGift(unlockAt, bytes32(0));
        vm.prank(sender);
        uint256 second = vault.createGift(address(secondAsset), recipient, 125_000_000, unlockAt, bytes32(0));

        uint256[] memory ids = new uint256[](2);
        ids[0] = first;
        ids[1] = second;
        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claimMany(ids);

        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
        assertEq(secondAsset.balanceOf(recipient), 125_000_000);
        assertEq(uint8(vault.getGift(first).status), uint8(SowmorrowVault.GiftStatus.Claimed));
        assertEq(uint8(vault.getGift(second).status), uint8(SowmorrowVault.GiftStatus.Claimed));
    }

    function test_claimMany_duplicateIdRevertsEntireBatch() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt, bytes32(0));
        uint256[] memory ids = new uint256[](2);
        ids[0] = giftId;
        ids[1] = giftId;

        vm.warp(unlockAt);
        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotActive.selector, giftId));
        vault.claimMany(ids);

        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(asset.balanceOf(recipient), 0);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT);
    }

    function test_claimMany_lockedMemberRevertsEarlierClaimsAtomically() public {
        uint64 firstUnlock = uint64(block.timestamp + 1);
        uint64 secondUnlock = uint64(block.timestamp + 2);
        uint256 first = _createGift(firstUnlock, bytes32(0));
        uint256 second = _createGift(secondUnlock, bytes32(0));
        uint256[] memory ids = new uint256[](2);
        ids[0] = first;
        ids[1] = second;

        vm.warp(firstUnlock);
        vm.prank(recipient);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.GiftStillLocked.selector, second, secondUnlock, firstUnlock)
        );
        vault.claimMany(ids);

        assertEq(uint8(vault.getGift(first).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(uint8(vault.getGift(second).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(asset.balanceOf(recipient), 0);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT * 2);
    }

    function test_claimMany_supportsExactlyMaxBatch() public {
        uint256 maxBatch = vault.MAX_BATCH();
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256[] memory ids = new uint256[](maxBatch);
        for (uint256 index; index < maxBatch; ++index) {
            ids[index] = _createGift(unlockAt, bytes32(index));
        }

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claimMany(ids);

        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT * maxBatch);
        assertEq(vault.totalEscrowed(address(asset)), 0);
    }

    function test_directTokenSurplusCannotChangeRecordedLiability() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt, bytes32(0));

        vm.prank(sender);
        asset.transfer(address(vault), 7 ether);
        assertEq(asset.balanceOf(address(vault)), GIFT_AMOUNT + 7 ether);
        assertEq(vault.totalEscrowed(address(asset)), GIFT_AMOUNT);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(asset.balanceOf(address(vault)), 7 ether);
        assertEq(vault.totalEscrowed(address(asset)), 0);
    }

    function test_forcedEtherAndUnknownCalldataDoNotCreateWithdrawalSurface() public {
        vm.deal(address(this), 1 ether);
        ForceEther force = new ForceEther{ value: 1 ether }();
        force.sendTo(payable(address(vault)));
        assertEq(address(vault).balance, 1 ether);

        (bool ethSuccess,) = address(vault).call{ value: 1 }("");
        assertFalse(ethSuccess);
        (bool calldataSuccess,) = address(vault).call(hex"deadbeef");
        assertFalse(calldataSuccess);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_createGift_acceptsMaximumUint64Unlock() public {
        uint256 giftId = _createGift(type(uint64).max, bytes32(0));
        assertEq(vault.getGift(giftId).unlockAt, type(uint64).max);
    }

    function testFuzz_createAndClaim_preservesExactRawAccounting(uint96 rawAmount, uint32 lockDelay, bytes32 noteHash)
        public
    {
        uint256 amount = bound(uint256(rawAmount), 1, STARTING_BALANCE);
        uint64 unlockAt = uint64(block.timestamp + bound(uint256(lockDelay), 1, 3650 days));

        vm.prank(sender);
        uint256 giftId = vault.createGift(address(asset), recipient, amount, unlockAt, noteHash);
        assertEq(vault.totalEscrowed(address(asset)), amount);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);

        assertEq(asset.balanceOf(recipient), amount);
        assertEq(vault.totalEscrowed(address(asset)), 0);
    }

    function test_setMinGiftAmountRaw_isOwnerOnlyAndValidatesInputs() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vault.setMinGiftAmountRaw(address(asset), 5 ether);

        address unsupported = makeAddr("unsupported-stock");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.UnsupportedStock.selector, unsupported));
        vault.setMinGiftAmountRaw(unsupported, 5 ether);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.MinGiftAmountZero.selector, address(asset)));
        vault.setMinGiftAmountRaw(address(asset), 0);

        uint256 cap = vault.MAX_MIN_GIFT_AMOUNT_RAW();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.MinGiftAmountExceedsMaximum.selector, address(asset), cap + 1, cap)
        );
        vault.setMinGiftAmountRaw(address(asset), cap + 1);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowVault.MinGiftAmountUnchanged.selector, address(asset), DEFAULT_MIN_AMOUNT_RAW
            )
        );
        vault.setMinGiftAmountRaw(address(asset), DEFAULT_MIN_AMOUNT_RAW);

        vm.expectEmit(true, false, false, true, address(vault));
        emit SowmorrowVault.MinGiftAmountSet(address(asset), 5 ether);
        vm.prank(admin);
        vault.setMinGiftAmountRaw(address(asset), 5 ether);
        assertEq(vault.minGiftAmountRaw(address(asset)), 5 ether);
    }

    function test_createGift_succeedsAtExactMinimumAndRevertsOneWeiBelow() public {
        vm.prank(admin);
        vault.setMinGiftAmountRaw(address(asset), 5 ether);
        uint64 unlockAt = uint64(block.timestamp + 1);

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowVault.GiftAmountBelowMinimum.selector, address(asset), 5 ether - 1, 5 ether)
        );
        vault.createGift(address(asset), recipient, 5 ether - 1, unlockAt, bytes32(0));

        vm.prank(sender);
        uint256 giftId = vault.createGift(address(asset), recipient, 5 ether, unlockAt, bytes32(0));
        assertEq(vault.getGift(giftId).amountRaw, 5 ether);
    }

    function test_raisingMinimum_leavesExistingActiveGiftClaimable() public {
        uint64 unlockAt = uint64(block.timestamp + 1);
        uint256 giftId = _createGift(unlockAt, bytes32(0));
        uint256 raisedMinimum = vault.MAX_MIN_GIFT_AMOUNT_RAW();
        assertLt(GIFT_AMOUNT, raisedMinimum);

        vm.prank(admin);
        vault.setMinGiftAmountRaw(address(asset), raisedMinimum);

        vm.warp(unlockAt);
        vm.prank(recipient);
        vault.claim(giftId);
        assertEq(asset.balanceOf(recipient), GIFT_AMOUNT);
        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Claimed));
    }

    function testFuzz_createGift_neverSucceedsBelowTheMinimum(uint256 minAmountSeed, uint256 amountSeed) public {
        uint256 minAmount = bound(minAmountSeed, 1, vault.MAX_MIN_GIFT_AMOUNT_RAW());
        uint256 amount = bound(amountSeed, 0, minAmount - 1);
        IB20Asset fuzzAsset =
            _newAsset(keccak256(abi.encodePacked("fuzz-min-asset", minAmountSeed)), "Fuzz Min Asset", "SMTF", 18);
        vm.prank(admin);
        vault.setSupportedStock(address(fuzzAsset), true, minAmount);

        uint256 giftIdBefore = vault.nextGiftId();
        if (amount == 0) {
            vm.expectRevert(SowmorrowVault.ZeroAmount.selector);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    SowmorrowVault.GiftAmountBelowMinimum.selector, address(fuzzAsset), amount, minAmount
                )
            );
        }
        vault.createGift(address(fuzzAsset), recipient, amount, uint64(block.timestamp + 1), bytes32(0));
        assertEq(vault.nextGiftId(), giftIdBefore);
    }

    function _newAsset(bytes32 salt, string memory name, string memory symbol, uint8 decimals)
        internal
        returns (IB20Asset)
    {
        return IB20Asset(_createAsset(alice, salt, _assetParams(name, symbol, admin, decimals), new bytes[](0)));
    }

    function _createGift(uint64 unlockAt, bytes32 noteHash) internal returns (uint256) {
        vm.prank(sender);
        return vault.createGift(address(asset), recipient, GIFT_AMOUNT, unlockAt, noteHash);
    }

    function _memo(uint256 giftId, uint8 action, bytes32 noteHash) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("SOWMORROW_BERYL_GIFT_MEMO_V1"), block.chainid, address(vault), giftId, action, noteHash
            )
        );
    }

    function _installAdversarialForCreate(AdversarialB20.Mode mode) internal returns (AdversarialB20 hostile) {
        vm.etch(address(asset), type(AdversarialB20).runtimeCode);
        hostile = AdversarialB20(address(asset));
        hostile.configure(address(vault), sender, recipient, STARTING_BALANCE, 0, 1, mode);
    }

    function _installAdversarialForClaim(AdversarialB20.Mode mode)
        internal
        returns (uint256 giftId, AdversarialB20 hostile)
    {
        uint64 unlockAt = uint64(block.timestamp + 1);
        giftId = _createGift(unlockAt, bytes32(0));
        vm.etch(address(asset), type(AdversarialB20).runtimeCode);
        hostile = AdversarialB20(address(asset));
        hostile.configure(address(vault), sender, recipient, 0, GIFT_AMOUNT, giftId, mode);
        vm.warp(unlockAt);
    }

    function _assertFailedCreateRollback(address stock) internal {
        assertEq(vault.nextGiftId(), 1);
        assertEq(vault.totalEscrowed(stock), 0);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowVault.GiftNotFound.selector, 1));
        vault.getGift(1);
    }

    function _assertFailedClaimRollback(uint256 giftId, address stock) internal view {
        assertEq(uint8(vault.getGift(giftId).status), uint8(SowmorrowVault.GiftStatus.Active));
        assertEq(vault.totalEscrowed(stock), GIFT_AMOUNT);
    }

    function _singleMinAmount(uint256 amount) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](1);
        amounts[0] = amount;
    }

    function _repeatedMinAmount(uint256 amount, uint256 count) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](count);
        for (uint256 index = 0; index < count; ++index) {
            amounts[index] = amount;
        }
    }

    modifier referenceModeOnly() {
        if (livePrecompiles) vm.skip(true);
        _;
    }
}
