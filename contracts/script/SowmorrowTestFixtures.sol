// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { B20Constants } from "base-std/lib/B20Constants.sol";
import { B20FactoryLib } from "base-std/lib/B20FactoryLib.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";
import { StdPrecompiles } from "base-std/StdPrecompiles.sol";

/// @title SowmorrowTestFixtures
/// @notice The one definition of the valueless B20 asset fixtures used by local and Base Sepolia runs.
/// @dev Every name and symbol is unmistakably a Sowmorrow test artifact and matches no listed company
///      or ticker. The deployment script and the fixture tests both read this library so a fixture
///      cannot drift between them.
library SowmorrowTestFixtures {
    /// @notice A single fixture definition.
    /// @param name ERC-20 name.
    /// @param symbol ERC-20 symbol.
    /// @param decimals ERC-20 decimals.
    /// @param salt Factory salt; combined with the creating sender it fixes the fixture address.
    struct Fixture {
        string name;
        string symbol;
        uint8 decimals;
        bytes32 salt;
    }

    /// @notice Number of fixtures created for a local or Base Sepolia stack.
    uint256 internal constant FIXTURE_COUNT = 13;

    /// @notice Decimals every fixture uses, matching the 18-decimal reviewed mainnet stocks.
    uint8 internal constant FIXTURE_DECIMALS = 18;

    /// @notice Raw supply minted to the deployer for each fixture.
    uint256 internal constant DEPLOYER_SUPPLY_RAW = 10_000 ether;

    /// @notice The fixture definitions, in the order the local manifest records them.
    function all() internal pure returns (Fixture[] memory fixtures) {
        string[13] memory ordinals = [
            "One",
            "Two",
            "Three",
            "Four",
            "Five",
            "Six",
            "Seven",
            "Eight",
            "Nine",
            "Ten",
            "Eleven",
            "Twelve",
            "Thirteen"
        ];
        string[13] memory symbols = [
            "SMT1", "SMT2", "SMT3", "SMT4", "SMT5", "SMT6", "SMT7", "SMT8", "SMT9", "SMT10", "SMT11", "SMT12", "SMT13"
        ];

        fixtures = new Fixture[](FIXTURE_COUNT);
        for (uint256 index = 0; index < FIXTURE_COUNT; ++index) {
            fixtures[index] = Fixture({
                name: string.concat("Sowmorrow Test Stock ", ordinals[index]),
                symbol: symbols[index],
                decimals: FIXTURE_DECIMALS,
                salt: keccak256(abi.encodePacked("sowmorrow-test-stock-", symbols[index]))
            });
        }
    }

    /// @notice Creates `fixture` through the B20 factory precompile with `admin` as its sole admin
    ///         and mint-role holder, and `DEPLOYER_SUPPLY_RAW` already minted to `admin`.
    /// @dev The caller must be `admin` so the fixture address stays deterministic for that sender.
    function create(Fixture memory fixture, address admin) internal returns (address token) {
        address[] memory recipients = new address[](1);
        recipients[0] = admin;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = DEPLOYER_SUPPLY_RAW;

        bytes[] memory initCalls = new bytes[](2);
        initCalls[0] = B20FactoryLib.encodeGrantRole(B20Constants.MINT_ROLE, admin);
        initCalls[1] = B20FactoryLib.encodeBatchMint(recipients, amounts);

        return StdPrecompiles.B20_FACTORY
            .createB20(
                IB20Factory.B20Variant.ASSET,
                fixture.salt,
                B20FactoryLib.encodeAssetCreateParams(fixture.name, fixture.symbol, admin, fixture.decimals),
                initCalls
            );
    }
}
