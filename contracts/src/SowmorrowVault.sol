// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { StdPrecompiles } from "base-std/StdPrecompiles.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";

/// @title SowmorrowVault
/// @notice Escrows Base B20 tokenized stocks as time-locked gifts. A sender deposits a raw token
///         amount for one recipient and one unlock timestamp; only that recipient can withdraw it,
///         and only once the timestamp has passed.
/// @dev The contract holds no upgrade path, no cancellation, no owner withdrawal, and no rescue
///      function. Every deposit and payout checks the vault's exact token balance delta, so a token
///      that charges fees, rebases, or under-delivers reverts the whole transaction. Availability of
///      a gift still depends on the issuer's B20 transfer policy for that stock.
contract SowmorrowVault is Ownable2Step, ReentrancyGuard {
    /// @notice Maximum number of gifts a single `claimMany` call may settle.
    uint256 public constant MAX_BATCH = 20;

    /// @notice Upper bound on any stock's minimum gift amount, in the token's raw units.
    /// @dev A sanity bound only: it stops the owner from fat-fingering a stock into being
    ///      practically unusable, since they can already disable it outright. It is not a
    ///      policy ceiling on how expensive a gift may be.
    uint256 public constant MAX_MIN_GIFT_AMOUNT_RAW = 1_000 ether;

    /// @notice Semantic version of this contract, checked by the deployment manifest tooling.
    string public constant VERSION = "1.0.0";

    bytes32 private constant MEMO_DOMAIN = keccak256("SOWMORROW_BERYL_GIFT_MEMO_V1");
    uint8 private constant DEPOSIT_ACTION = 0;
    uint8 private constant CLAIM_ACTION = 1;

    /// @notice Lifecycle of a gift. `None` marks an id that was never created.
    enum GiftStatus {
        None,
        Active,
        Claimed
    }

    /// @notice A single escrowed gift.
    /// @param sender Address that deposited the tokens.
    /// @param recipient Only address allowed to claim.
    /// @param stock B20 asset token held in escrow.
    /// @param unlockAt Unix timestamp from which `claim` succeeds.
    /// @param status Current lifecycle state.
    /// @param amountRaw Escrowed amount in the token's raw units, unaffected by later multiplier changes.
    /// @param noteHash keccak256 of the sender's off-chain note, or zero when there is none.
    struct Gift {
        address sender;
        address recipient;
        address stock;
        uint64 unlockAt;
        GiftStatus status;
        uint256 amountRaw;
        bytes32 noteHash;
    }

    /// @notice Id assigned to the next created gift. Ids start at 1 and only increase.
    uint256 public nextGiftId = 1;

    /// @notice When true, `createGift` reverts. Claims are never affected.
    bool public creationPaused;

    mapping(uint256 giftId => Gift gift) private gifts;

    /// @notice Whether a stock is currently accepted for new gifts.
    mapping(address stock => bool supported) public supportedStock;

    /// @notice Sum of `amountRaw` across all active gifts of a stock.
    /// @dev Equals the vault's expected balance of that stock, excluding tokens sent directly
    ///      to the contract and tokens seized by the issuer.
    mapping(address stock => uint256 amountRaw) public totalEscrowed;

    /// @notice Smallest `amountRaw` `createGift` accepts for a stock. Zero for an unsupported stock.
    /// @dev Every currently supported stock holds a non-zero minimum; enabling a stock always sets
    ///      one and disabling always clears it back to zero. Changing this value never affects a
    ///      gift that already exists.
    mapping(address stock => uint256 amountRaw) public minGiftAmountRaw;

    /// @notice New gifts are paused.
    error CreationPaused();
    /// @notice The pause flag already holds the requested value.
    error CreationPauseUnchanged(bool paused);
    /// @notice The stock is not on the allowlist.
    error UnsupportedStock(address stock);
    /// @notice The address is not a B20 token.
    error StockNotB20(address stock);
    /// @notice The B20 token has not finished initialization.
    error StockNotInitialized(address stock);
    /// @notice The B20 token is not the ASSET variant.
    error StockNotAsset(address stock);
    /// @notice `WAD_PRECISION` or `multiplier` could not be read from the token.
    error StockAssetInterfaceInvalid(address stock);
    /// @notice The token's `WAD_PRECISION` is not 1e18.
    error StockPrecisionInvalid(address stock, uint256 precision);
    /// @notice The token's multiplier is zero.
    error StockMultiplierInvalid(address stock);
    /// @notice The allowlist already holds the requested value for this stock.
    error StockSupportUnchanged(address stock, bool supported);
    /// @notice `initialStocks` and `initialMinGiftAmountsRaw` have different lengths.
    error InitialStocksMinAmountsLengthMismatch(uint256 stocksLength, uint256 minAmountsLength);
    /// @notice A minimum gift amount of zero was supplied while enabling a stock or calling
    ///         `setMinGiftAmountRaw`.
    error MinGiftAmountZero(address stock);
    /// @notice A minimum gift amount above `MAX_MIN_GIFT_AMOUNT_RAW` was supplied.
    error MinGiftAmountExceedsMaximum(address stock, uint256 amountRaw, uint256 maximum);
    /// @notice A non-zero minimum gift amount was supplied while disabling a stock.
    error MinGiftAmountMustBeZeroToDisable(address stock, uint256 amountRaw);
    /// @notice `setMinGiftAmountRaw` already holds the requested value for this stock.
    error MinGiftAmountUnchanged(address stock, uint256 amountRaw);
    /// @notice A gift amount of zero was supplied.
    error ZeroAmount();
    /// @notice The supplied gift amount is below the stock's current minimum.
    error GiftAmountBelowMinimum(address stock, uint256 supplied, uint256 minimum);
    /// @notice The recipient is the zero address or this contract.
    error InvalidRecipient(address recipient);
    /// @notice The unlock timestamp is not after the current block timestamp.
    error UnlockNotInFuture(uint64 unlockAt, uint256 currentTime);
    /// @notice No gift exists with this id.
    error GiftNotFound(uint256 giftId);
    /// @notice The gift has already been claimed.
    error GiftNotActive(uint256 giftId);
    /// @notice The caller is not the gift's recipient.
    error NotGiftRecipient(uint256 giftId, address caller, address recipient);
    /// @notice The gift's unlock timestamp has not been reached.
    error GiftStillLocked(uint256 giftId, uint64 unlockAt, uint256 currentTime);
    /// @notice `claimMany` was called with no ids.
    error EmptyBatch();
    /// @notice `claimMany` was called with more than `MAX_BATCH` ids.
    error BatchTooLarge(uint256 supplied, uint256 maximum);
    /// @notice The token returned false from a transfer.
    error TokenTransferFailed(address stock);
    /// @notice The vault's token balance did not move by exactly the gift amount.
    error UnexpectedTokenBalanceDelta(address stock, uint256 expected, uint256 balanceBefore, uint256 balanceAfter);
    /// @notice Ownership can be transferred but never renounced.
    error OwnershipRenunciationDisabled();

    /// @notice A gift was created and its tokens are held by the vault.
    /// @param giftId Id of the new gift.
    /// @param sender Depositor.
    /// @param recipient Only address that can claim.
    /// @param stock B20 asset token.
    /// @param amountRaw Escrowed raw units.
    /// @param unlockAt Unix timestamp from which the gift can be claimed.
    /// @param noteHash keccak256 of the off-chain note, or zero.
    event GiftCreated(
        uint256 indexed giftId,
        address indexed sender,
        address indexed recipient,
        address stock,
        uint256 amountRaw,
        uint64 unlockAt,
        bytes32 noteHash
    );

    /// @notice A gift was paid out to its recipient.
    /// @param giftId Id of the claimed gift.
    /// @param recipient Address that received the tokens.
    /// @param stock B20 asset token.
    /// @param amountRaw Raw units transferred.
    event GiftClaimed(uint256 indexed giftId, address indexed recipient, address indexed stock, uint256 amountRaw);

    /// @notice A stock was added to or removed from the allowlist.
    event SupportedStockSet(address indexed stock, bool supported);

    /// @notice A stock's minimum gift amount was set, from the constructor, `setSupportedStock`
    ///         enabling the stock, or `setMinGiftAmountRaw`.
    /// @param stock B20 asset token.
    /// @param amountRaw New minimum, in the token's raw units.
    event MinGiftAmountSet(address indexed stock, uint256 amountRaw);

    /// @notice New gift creation was paused or resumed.
    event CreationPausedSet(bool paused);

    /// @notice Deploys the vault with an initial allowlist.
    /// @dev Every address in `initialStocks` is validated as an initialized B20 ASSET token with
    ///      1e18 precision and a non-zero multiplier; the constructor reverts on the first failure
    ///      or duplicate. `initialMinGiftAmountsRaw[i]` is `initialStocks[i]`'s minimum and must be
    ///      non-zero and at most `MAX_MIN_GIFT_AMOUNT_RAW`; the arrays must be the same length.
    /// @param initialOwner Address that receives ownership. Must not be zero.
    /// @param initialStocks Stocks accepted for new gifts from deployment.
    /// @param initialMinGiftAmountsRaw Minimum `createGift` amount for each stock in `initialStocks`,
    ///        in raw units, at the same index.
    /// @param startPaused When true, gift creation starts paused.
    constructor(
        address initialOwner,
        address[] memory initialStocks,
        uint256[] memory initialMinGiftAmountsRaw,
        bool startPaused
    ) Ownable(initialOwner) {
        uint256 stockCount = initialStocks.length;
        if (stockCount != initialMinGiftAmountsRaw.length) {
            revert InitialStocksMinAmountsLengthMismatch(stockCount, initialMinGiftAmountsRaw.length);
        }
        for (uint256 index = 0; index < stockCount; ++index) {
            _setSupportedStock(initialStocks[index], true, initialMinGiftAmountsRaw[index]);
        }
        if (startPaused) {
            creationPaused = true;
            emit CreationPausedSet(true);
        }
    }

    /// @notice Deposits `amountRaw` of `stock` as a gift for `recipient`, claimable from `unlockAt`.
    /// @dev The caller must have approved the vault for at least `amountRaw`. The gift record and
    ///      liability are written before the transfer, and the whole call reverts unless the vault's
    ///      balance grows by exactly `amountRaw`. The transfer memo commits to the gift id, the
    ///      deposit action, and `noteHash`. `ZeroAmount` is checked before `GiftAmountBelowMinimum`
    ///      so a caller who supplies zero always sees `ZeroAmount`, even though every supported
    ///      stock's minimum is already non-zero and would reject zero on its own.
    /// @param stock Allowlisted B20 asset token.
    /// @param recipient Address that will be able to claim. Cannot be zero or this contract.
    /// @param amountRaw Amount in the token's raw units. Must be at least `minGiftAmountRaw[stock]`.
    /// @param unlockAt Unix timestamp from which the recipient may claim. Must be in the future.
    /// @param noteHash keccak256 of the sender's off-chain note, or zero for no note.
    /// @return giftId Id of the created gift.
    function createGift(address stock, address recipient, uint256 amountRaw, uint64 unlockAt, bytes32 noteHash)
        external
        nonReentrant
        returns (uint256 giftId)
    {
        if (creationPaused) revert CreationPaused();
        if (!supportedStock[stock]) revert UnsupportedStock(stock);
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient(recipient);
        }
        if (amountRaw == 0) revert ZeroAmount();
        uint256 minimumRaw = minGiftAmountRaw[stock];
        if (amountRaw < minimumRaw) revert GiftAmountBelowMinimum(stock, amountRaw, minimumRaw);
        if (uint256(unlockAt) <= block.timestamp) {
            revert UnlockNotInFuture(unlockAt, block.timestamp);
        }

        IB20 token = IB20(stock);
        uint256 balanceBefore = token.balanceOf(address(this));

        giftId = nextGiftId;
        nextGiftId = giftId + 1;
        gifts[giftId] = Gift({
            sender: msg.sender,
            recipient: recipient,
            stock: stock,
            unlockAt: unlockAt,
            status: GiftStatus.Active,
            amountRaw: amountRaw,
            noteHash: noteHash
        });
        totalEscrowed[stock] += amountRaw;

        bool transferred =
            token.transferFromWithMemo(msg.sender, address(this), amountRaw, _memo(giftId, DEPOSIT_ACTION, noteHash));
        if (!transferred) revert TokenTransferFailed(stock);

        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amountRaw) {
            revert UnexpectedTokenBalanceDelta(stock, amountRaw, balanceBefore, balanceAfter);
        }

        emit GiftCreated(giftId, msg.sender, recipient, stock, amountRaw, unlockAt, noteHash);
    }

    /// @notice Pays one unlocked gift to its recipient, who must be the caller.
    /// @dev Works even when creation is paused or the stock has since left the allowlist.
    /// @param giftId Id of the gift to claim.
    function claim(uint256 giftId) external nonReentrant {
        _claim(giftId, msg.sender);
    }

    /// @notice Pays up to `MAX_BATCH` unlocked gifts to the caller in one transaction.
    /// @dev Atomic: if any id is missing, already claimed, still locked, addressed to someone else,
    ///      duplicated, or blocked by the token, no gift in the batch is paid.
    /// @param giftIds Ids to claim, settled in calldata order.
    function claimMany(uint256[] calldata giftIds) external nonReentrant {
        uint256 count = giftIds.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge(count, MAX_BATCH);

        for (uint256 index = 0; index < count; ++index) {
            _claim(giftIds[index], msg.sender);
        }
    }

    /// @notice Returns a gift record.
    /// @param giftId Id to look up.
    /// @return gift The stored record. Reverts with `GiftNotFound` for ids that were never created.
    function getGift(uint256 giftId) external view returns (Gift memory gift) {
        gift = gifts[giftId];
        if (gift.status == GiftStatus.None) revert GiftNotFound(giftId);
    }

    /// @notice Adds a stock to, or removes it from, the allowlist for new gifts.
    /// @dev Adding re-validates the token every time and requires a fresh minimum; removing never
    ///      affects existing gifts and clears the stored minimum.
    /// @param stock B20 asset token.
    /// @param supported True to accept new gifts of this stock, false to stop.
    /// @param minAmountRaw When enabling, the stock's minimum `createGift` amount in raw units;
    ///        must be non-zero and at most `MAX_MIN_GIFT_AMOUNT_RAW`. When disabling, must be zero.
    function setSupportedStock(address stock, bool supported, uint256 minAmountRaw) external onlyOwner {
        _setSupportedStock(stock, supported, minAmountRaw);
    }

    /// @notice Updates the minimum `createGift` amount for an already supported stock.
    /// @dev Never affects a gift that already exists; only changes what a future `createGift` call
    ///      accepts.
    /// @param stock Currently supported B20 asset token.
    /// @param amountRaw New minimum in the token's raw units. Must be non-zero, at most
    ///        `MAX_MIN_GIFT_AMOUNT_RAW`, and different from the current minimum.
    function setMinGiftAmountRaw(address stock, uint256 amountRaw) external onlyOwner {
        if (!supportedStock[stock]) revert UnsupportedStock(stock);
        _requireValidMinGiftAmount(stock, amountRaw);
        if (minGiftAmountRaw[stock] == amountRaw) revert MinGiftAmountUnchanged(stock, amountRaw);
        minGiftAmountRaw[stock] = amountRaw;
        emit MinGiftAmountSet(stock, amountRaw);
    }

    /// @notice Pauses or resumes new gift creation. Claims are unaffected.
    /// @param paused True to pause, false to resume.
    function setCreationPaused(bool paused) external onlyOwner {
        if (creationPaused == paused) revert CreationPauseUnchanged(paused);
        creationPaused = paused;
        emit CreationPausedSet(paused);
    }

    /// @notice Disabled. The vault must always have an owner able to manage the allowlist.
    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    /// @dev Shared claim path. Marks the gift claimed and reduces the liability before the
    ///      transfer, then requires the vault's balance to drop by exactly `amountRaw`.
    function _claim(uint256 giftId, address caller) private {
        Gift storage gift = gifts[giftId];
        if (gift.status == GiftStatus.None) revert GiftNotFound(giftId);
        if (gift.status != GiftStatus.Active) revert GiftNotActive(giftId);
        if (caller != gift.recipient) {
            revert NotGiftRecipient(giftId, caller, gift.recipient);
        }
        if (block.timestamp < gift.unlockAt) {
            revert GiftStillLocked(giftId, gift.unlockAt, block.timestamp);
        }

        IB20 token = IB20(gift.stock);
        uint256 balanceBefore = token.balanceOf(address(this));

        gift.status = GiftStatus.Claimed;
        totalEscrowed[gift.stock] -= gift.amountRaw;

        bool transferred = token.transferWithMemo(caller, gift.amountRaw, _memo(giftId, CLAIM_ACTION, gift.noteHash));
        if (!transferred) revert TokenTransferFailed(gift.stock);

        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter > balanceBefore || balanceBefore - balanceAfter != gift.amountRaw) {
            revert UnexpectedTokenBalanceDelta(gift.stock, gift.amountRaw, balanceBefore, balanceAfter);
        }

        emit GiftClaimed(giftId, caller, gift.stock, gift.amountRaw);
    }

    /// @dev Writes the allowlist flag, validating the token and the minimum when enabling, and
    ///      clearing the stored minimum when disabling. Reverts on a no-op so duplicate constructor
    ///      entries and redundant owner calls are caught.
    function _setSupportedStock(address stock, bool supported, uint256 minAmountRaw) private {
        if (supportedStock[stock] == supported) {
            revert StockSupportUnchanged(stock, supported);
        }
        if (supported) {
            _validateAsset(stock);
            _requireValidMinGiftAmount(stock, minAmountRaw);
            minGiftAmountRaw[stock] = minAmountRaw;
            emit MinGiftAmountSet(stock, minAmountRaw);
        } else {
            if (minAmountRaw != 0) revert MinGiftAmountMustBeZeroToDisable(stock, minAmountRaw);
            delete minGiftAmountRaw[stock];
        }
        supportedStock[stock] = supported;
        emit SupportedStockSet(stock, supported);
    }

    /// @dev Shared bound check for a stock's minimum gift amount: non-zero and at most
    ///      `MAX_MIN_GIFT_AMOUNT_RAW`. Used by both enabling a stock and `setMinGiftAmountRaw`.
    function _requireValidMinGiftAmount(address stock, uint256 amountRaw) private pure {
        if (amountRaw == 0) revert MinGiftAmountZero(stock);
        if (amountRaw > MAX_MIN_GIFT_AMOUNT_RAW) {
            revert MinGiftAmountExceedsMaximum(stock, amountRaw, MAX_MIN_GIFT_AMOUNT_RAW);
        }
    }

    /// @dev Checks that `stock` is an initialized B20 ASSET token from the Base factory precompile
    ///      with 1e18 `WAD_PRECISION` and a non-zero multiplier. The variant is read from byte 10 of
    ///      the factory-derived address.
    function _validateAsset(address stock) private view {
        IB20Factory factory = StdPrecompiles.B20_FACTORY;
        if (!factory.isB20(stock)) revert StockNotB20(stock);
        if (!factory.isB20Initialized(stock)) revert StockNotInitialized(stock);
        if (uint8(bytes20(stock)[10]) != uint8(IB20Factory.B20Variant.ASSET)) {
            revert StockNotAsset(stock);
        }

        try IB20Asset(stock).WAD_PRECISION() returns (uint256 precision) {
            if (precision != 1 ether) revert StockPrecisionInvalid(stock, precision);
        } catch {
            revert StockAssetInterfaceInvalid(stock);
        }

        try IB20Asset(stock).multiplier() returns (uint256 multiplier) {
            if (multiplier == 0) revert StockMultiplierInvalid(stock);
        } catch {
            revert StockAssetInterfaceInvalid(stock);
        }
    }

    /// @dev Transfer memo binding a token movement to this chain, this vault, one gift id, the
    ///      action (deposit or claim), and the note hash.
    function _memo(uint256 giftId, uint8 action, bytes32 noteHash) private view returns (bytes32) {
        return keccak256(abi.encode(MEMO_DOMAIN, block.chainid, address(this), giftId, action, noteHash));
    }
}
