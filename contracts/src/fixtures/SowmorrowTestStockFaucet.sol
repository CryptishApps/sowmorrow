// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IB20 } from "base-std/interfaces/IB20.sol";
import { IB20Asset } from "base-std/interfaces/IB20Asset.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";
import { StdPrecompiles } from "base-std/StdPrecompiles.sol";

/// @title SowmorrowTestStockFaucet
/// @notice Test-only faucet that mints bounded amounts of valueless Sowmorrow B20 asset fixtures.
/// @dev This contract is never part of a Base mainnet deployment: the constructor and every mint
///      path reject any chain other than the local development chain and Base Sepolia, and nothing
///      under `script/DeploySowmorrow.s.sol` imports it.
contract SowmorrowTestStockFaucet {
    /// @notice Anvil / base-anvil development chain.
    uint256 public constant LOCAL_CHAIN_ID = 31337;

    /// @notice Base Sepolia public test network.
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /// @notice Largest raw amount a single request may mint.
    uint256 public constant MAX_REQUEST_RAW = 100 ether;

    /// @notice Time an address must wait between two successful requests.
    uint64 public constant REQUEST_COOLDOWN = 1 hours;

    address[] private fixtures;

    /// @notice Whether `stock` is one of the fixtures this faucet may mint.
    mapping(address stock => bool isFixture) public supportedFixture;

    /// @notice Timestamp from which `account` may request again. Zero means never requested.
    mapping(address account => uint64 availableAt) public nextRequestAt;

    error FaucetChainForbidden(uint256 chainId);
    error FixtureSetEmpty();
    error FixtureDuplicated(address stock);
    error FixtureNotB20(address stock);
    error FixtureNotInitialized(address stock);
    error FixtureNotAsset(address stock);
    error FixtureInterfaceInvalid(address stock);
    error FixtureUnsupported(address stock);
    error RequestAmountZero();
    error RequestAmountTooLarge(uint256 requested, uint256 maximum);
    error RequestCooldownActive(address account, uint64 availableAt, uint256 currentTime);
    error FixtureMintFailed(address stock, address account, uint256 amountRaw);

    /// @notice A fixture mint succeeded.
    event FixtureMinted(address indexed stock, address indexed account, uint256 amountRaw, uint64 availableAt);

    /// @param testFixtures Initialized B20 ASSET fixtures this faucet is allowed to mint.
    constructor(address[] memory testFixtures) {
        _requireTestChain();
        uint256 count = testFixtures.length;
        if (count == 0) revert FixtureSetEmpty();
        for (uint256 index = 0; index < count; ++index) {
            address stock = testFixtures[index];
            if (supportedFixture[stock]) revert FixtureDuplicated(stock);
            _validateFixture(stock);
            supportedFixture[stock] = true;
            fixtures.push(stock);
        }
    }

    /// @notice Mints `amountRaw` of `stock` to the caller once the caller's cooldown has expired.
    /// @param stock Fixture registered at construction.
    /// @param amountRaw Raw amount to mint. Must be non-zero and at most `MAX_REQUEST_RAW`.
    function requestFixture(address stock, uint256 amountRaw) external {
        _requireTestChain();
        if (!supportedFixture[stock]) revert FixtureUnsupported(stock);
        if (amountRaw == 0) revert RequestAmountZero();
        if (amountRaw > MAX_REQUEST_RAW) revert RequestAmountTooLarge(amountRaw, MAX_REQUEST_RAW);

        uint64 availableAt = nextRequestAt[msg.sender];
        if (block.timestamp < availableAt) {
            revert RequestCooldownActive(msg.sender, availableAt, block.timestamp);
        }

        uint64 nextAvailableAt = uint64(block.timestamp) + REQUEST_COOLDOWN;
        nextRequestAt[msg.sender] = nextAvailableAt;

        uint256 balanceBefore = IB20(stock).balanceOf(msg.sender);
        IB20(stock).mint(msg.sender, amountRaw);
        uint256 balanceAfter = IB20(stock).balanceOf(msg.sender);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amountRaw) {
            revert FixtureMintFailed(stock, msg.sender, amountRaw);
        }

        emit FixtureMinted(stock, msg.sender, amountRaw, nextAvailableAt);
    }

    /// @notice Every fixture this faucet may mint, in registration order.
    function allFixtures() external view returns (address[] memory) {
        return fixtures;
    }

    /// @notice Number of registered fixtures.
    function fixtureCount() external view returns (uint256) {
        return fixtures.length;
    }

    /// @notice Registered fixture at `index`.
    function fixtureAt(uint256 index) external view returns (address) {
        return fixtures[index];
    }

    function _requireTestChain() private view {
        if (block.chainid != LOCAL_CHAIN_ID && block.chainid != BASE_SEPOLIA_CHAIN_ID) {
            revert FaucetChainForbidden(block.chainid);
        }
    }

    function _validateFixture(address stock) private view {
        IB20Factory factory = StdPrecompiles.B20_FACTORY;
        if (!factory.isB20(stock)) revert FixtureNotB20(stock);
        if (!factory.isB20Initialized(stock)) revert FixtureNotInitialized(stock);
        if (uint8(bytes20(stock)[10]) != uint8(IB20Factory.B20Variant.ASSET)) {
            revert FixtureNotAsset(stock);
        }

        try IB20Asset(stock).WAD_PRECISION() returns (uint256 precision) {
            if (precision != 1 ether) revert FixtureInterfaceInvalid(stock);
        } catch {
            revert FixtureInterfaceInvalid(stock);
        }

        try IB20Asset(stock).multiplier() returns (uint256 multiplier) {
            if (multiplier == 0) revert FixtureInterfaceInvalid(stock);
        } catch {
            revert FixtureInterfaceInvalid(stock);
        }
    }
}
