// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script } from "forge-std/Script.sol";
import { SowmorrowVault } from "../src/SowmorrowVault.sol";
import { ReviewedStocks } from "../src/generated/ReviewedStocks.sol";

/// @notice The part of the Safe singleton API this deployment relies on.
interface ISafeSignerPolicy {
    /// @notice Number of signatures a Safe transaction requires.
    function getThreshold() external view returns (uint256);

    /// @notice Current Safe owner set.
    function getOwners() external view returns (address[] memory);
}

/// @title DeploySowmorrow
/// @notice Deploys `SowmorrowVault` for the selected chain.
contract DeploySowmorrow is Script {
    /// @notice Minimum number of Safe signatures required for the mainnet owner.
    uint256 public constant MINIMUM_OWNER_THRESHOLD = 2;

    /// @notice Minimum size of the mainnet owner's Safe signer set.
    uint256 public constant MINIMUM_OWNER_SIGNERS = 3;

    error InvalidOwnerKind();
    error UnsupportedChain(uint256 chainId);
    error MainnetMustStartPaused();
    error MainnetOwnerMustBeContract(address owner);
    error MainnetOwnerNotSafe(address owner);
    error MainnetOwnerThresholdTooLow(address owner, uint256 threshold, uint256 minimum);
    error MainnetOwnerSignerSetTooSmall(address owner, uint256 signers, uint256 minimum);
    error MainnetOwnerThresholdExceedsSigners(address owner, uint256 threshold, uint256 signers);
    error MainnetOwnerSignerInvalid(address owner, address signer);
    error MainnetOwnerSignerDuplicated(address owner, address signer);
    error TestEnvironmentNeedsStockFixtures();
    error TestEnvironmentStockAndMinAmountCountMismatch(uint256 stocksLength, uint256 minAmountsLength);

    /// @notice Per-share raw-unit minimum for a reviewed stock trading above roughly $200 at review
    ///         time: 0.01 shares at 1e18 precision.
    uint256 public constant MIN_GIFT_HIGH_PRICE_STOCK_RAW = 0.01 ether;

    /// @notice Per-share raw-unit minimum for a reviewed stock trading below roughly $200 at review
    ///         time: 0.2 shares at 1e18 precision.
    uint256 public constant MIN_GIFT_LOW_PRICE_STOCK_RAW = 0.2 ether;

    function run() external returns (SowmorrowVault vault) {
        address owner = vm.envAddress("SOWMORROW_OWNER");
        bool startPaused = vm.envBool("SOWMORROW_START_PAUSED");
        address[] memory stocks;
        uint256[] memory minGiftAmountsRaw;

        if (block.chainid == 8453) {
            if (!startPaused) revert MainnetMustStartPaused();
            requireMainnetOwner(owner, vm.envOr("SOWMORROW_OWNER_KIND", string("safe")));
            stocks = ReviewedStocks.mainnet();
            minGiftAmountsRaw = reviewedMinGiftAmountsRaw();
        } else if (block.chainid == 84532 || block.chainid == 31337) {
            stocks = vm.envAddress("SOWMORROW_STOCKS", ",");
            if (stocks.length == 0) revert TestEnvironmentNeedsStockFixtures();
            minGiftAmountsRaw = vm.envUint("SOWMORROW_MIN_AMOUNTS_RAW", ",");
            if (minGiftAmountsRaw.length != stocks.length) {
                revert TestEnvironmentStockAndMinAmountCountMismatch(stocks.length, minGiftAmountsRaw.length);
            }
        } else {
            revert UnsupportedChain(block.chainid);
        }

        vm.startBroadcast();
        vault = new SowmorrowVault(owner, stocks, minGiftAmountsRaw, startPaused);
        vm.stopBroadcast();
    }

    /// @notice Launch minimum for each reviewed mainnet stock, at the same index as
    ///         `ReviewedStocks.mainnet()`. These are manual, review-time judgements of roughly five
    ///         US dollars of stock rounded to a clean fraction of a share, not oracle-derived
    ///         values, and the owner updates them over time with `setMinGiftAmountRaw`.
    function reviewedMinGiftAmountsRaw() public pure returns (uint256[] memory amounts) {
        uint256 aaplc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 amznc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 coinc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 crclc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 googlc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 intcc = MIN_GIFT_LOW_PRICE_STOCK_RAW;
        uint256 metac = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 msftc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 mstrc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 nvdac = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 sndkc = MIN_GIFT_LOW_PRICE_STOCK_RAW;
        uint256 spcxc = MIN_GIFT_HIGH_PRICE_STOCK_RAW;
        uint256 tslac = MIN_GIFT_HIGH_PRICE_STOCK_RAW;

        amounts = new uint256[](13);
        amounts[0] = aaplc;
        amounts[1] = amznc;
        amounts[2] = coinc;
        amounts[3] = crclc;
        amounts[4] = googlc;
        amounts[5] = intcc;
        amounts[6] = metac;
        amounts[7] = msftc;
        amounts[8] = mstrc;
        amounts[9] = nvdac;
        amounts[10] = sndkc;
        amounts[11] = spcxc;
        amounts[12] = tslac;
    }

    function requireMainnetOwner(address owner, string memory kind) public view {
        if (keccak256(bytes(kind)) == keccak256("safe")) {
            requireReviewedSafe(owner);
        } else if (keccak256(bytes(kind)) == keccak256("smart-wallet")) {
            if (owner.code.length == 0) revert MainnetOwnerMustBeContract(owner);
        } else {
            revert InvalidOwnerKind();
        }
    }

    /// @notice Reverts unless `owner` answers the Safe signer-policy API with a reviewed configuration.
    /// @param owner Address proposed as the vault owner.
    function requireReviewedSafe(address owner) public view {
        if (owner.code.length == 0) revert MainnetOwnerMustBeContract(owner);

        uint256 threshold;
        address[] memory signers;

        try ISafeSignerPolicy(owner).getThreshold() returns (uint256 reportedThreshold) {
            threshold = reportedThreshold;
        } catch {
            revert MainnetOwnerNotSafe(owner);
        }

        try ISafeSignerPolicy(owner).getOwners() returns (address[] memory reportedSigners) {
            signers = reportedSigners;
        } catch {
            revert MainnetOwnerNotSafe(owner);
        }

        if (threshold < MINIMUM_OWNER_THRESHOLD) {
            revert MainnetOwnerThresholdTooLow(owner, threshold, MINIMUM_OWNER_THRESHOLD);
        }
        if (signers.length < MINIMUM_OWNER_SIGNERS) {
            revert MainnetOwnerSignerSetTooSmall(owner, signers.length, MINIMUM_OWNER_SIGNERS);
        }
        if (threshold > signers.length) {
            revert MainnetOwnerThresholdExceedsSigners(owner, threshold, signers.length);
        }

        for (uint256 index = 0; index < signers.length; ++index) {
            address signer = signers[index];
            if (signer == address(0) || signer == owner) revert MainnetOwnerSignerInvalid(owner, signer);
            for (uint256 other = 0; other < index; ++other) {
                if (signers[other] == signer) revert MainnetOwnerSignerDuplicated(owner, signer);
            }
        }
    }
}
