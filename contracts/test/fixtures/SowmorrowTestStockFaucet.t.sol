// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { B20FactoryTest } from "base-std-test/lib/B20FactoryTest.sol";
import { B20Constants } from "base-std/lib/B20Constants.sol";
import { IB20 } from "base-std/interfaces/IB20.sol";
import { IB20Factory } from "base-std/interfaces/IB20Factory.sol";
import { SowmorrowTestStockFaucet } from "../../src/fixtures/SowmorrowTestStockFaucet.sol";

contract SowmorrowTestStockFaucetTest is B20FactoryTest {
    SowmorrowTestStockFaucet internal faucet;
    address internal fixtureOne;
    address internal fixtureTwo;
    address internal claimer = makeAddr("faucet-claimer");
    address internal otherClaimer = makeAddr("other-faucet-claimer");

    function setUp() public override {
        super.setUp();
        vm.chainId(31337);
        vm.warp(1_800_000_000);

        fixtureOne = _createAsset(
            admin,
            keccak256("sowmorrow-test-stock-SMT1"),
            _assetParams("Sowmorrow Test Stock One", "SMT1", admin, 18),
            new bytes[](0)
        );
        fixtureTwo = _createAsset(
            admin,
            keccak256("sowmorrow-test-stock-SMT2"),
            _assetParams("Sowmorrow Test Stock Two", "SMT2", admin, 18),
            new bytes[](0)
        );

        faucet = new SowmorrowTestStockFaucet(_fixtureSet());
        vm.prank(admin);
        IB20(fixtureOne).grantRole(B20Constants.MINT_ROLE, address(faucet));
        vm.prank(admin);
        IB20(fixtureTwo).grantRole(B20Constants.MINT_ROLE, address(faucet));
    }

    function _fixtureSet() internal view returns (address[] memory set) {
        set = new address[](2);
        set[0] = fixtureOne;
        set[1] = fixtureTwo;
    }

    function test_constructor_registersOnlyTheGivenFixtures() public {
        assertEq(faucet.fixtureCount(), 2);
        assertEq(faucet.fixtureAt(0), fixtureOne);
        assertEq(faucet.fixtureAt(1), fixtureTwo);
        assertEq(faucet.allFixtures().length, 2);
        assertTrue(faucet.supportedFixture(fixtureOne));
        assertTrue(faucet.supportedFixture(fixtureTwo));
        assertFalse(faucet.supportedFixture(makeAddr("unrelated")));
        assertEq(faucet.MAX_REQUEST_RAW(), 100 ether);
        assertEq(faucet.REQUEST_COOLDOWN(), 1 hours);
    }

    function test_constructor_revertsOnBaseMainnet() public {
        vm.chainId(8453);
        address[] memory set = _fixtureSet();
        vm.expectRevert(abi.encodeWithSelector(SowmorrowTestStockFaucet.FaucetChainForbidden.selector, 8453));
        new SowmorrowTestStockFaucet(set);
    }

    function test_constructor_acceptsBaseSepolia() public {
        vm.chainId(84532);
        SowmorrowTestStockFaucet sepoliaFaucet = new SowmorrowTestStockFaucet(_fixtureSet());
        assertEq(sepoliaFaucet.fixtureCount(), 2);
    }

    function test_constructor_revertsForEmptyFixtureSet() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(SowmorrowTestStockFaucet.FixtureSetEmpty.selector);
        new SowmorrowTestStockFaucet(empty);
    }

    function test_constructor_revertsForDuplicateFixture() public {
        address[] memory duplicated = new address[](2);
        duplicated[0] = fixtureOne;
        duplicated[1] = fixtureOne;
        vm.expectRevert(abi.encodeWithSelector(SowmorrowTestStockFaucet.FixtureDuplicated.selector, fixtureOne));
        new SowmorrowTestStockFaucet(duplicated);
    }

    function test_constructor_revertsForOrdinaryAddress() public {
        address ordinary = makeAddr("ordinary");
        address[] memory set = new address[](1);
        set[0] = ordinary;
        vm.expectRevert(abi.encodeWithSelector(SowmorrowTestStockFaucet.FixtureNotB20.selector, ordinary));
        new SowmorrowTestStockFaucet(set);
    }

    function test_constructor_revertsForUninitializedFixture() public {
        address uninitialized =
            factory.getB20Address(IB20Factory.B20Variant.ASSET, address(this), keccak256("never-created"));
        address[] memory set = new address[](1);
        set[0] = uninitialized;
        vm.expectRevert(abi.encodeWithSelector(SowmorrowTestStockFaucet.FixtureNotInitialized.selector, uninitialized));
        new SowmorrowTestStockFaucet(set);
    }

    function test_constructor_revertsForStablecoinVariant() public {
        address stablecoin = _createStablecoin();
        address[] memory set = new address[](1);
        set[0] = stablecoin;
        vm.expectRevert(abi.encodeWithSelector(SowmorrowTestStockFaucet.FixtureNotAsset.selector, stablecoin));
        new SowmorrowTestStockFaucet(set);
    }

    function test_requestFixture_mintsToTheCallerAndStartsTheCooldown() public {
        uint64 expectedAvailableAt = uint64(block.timestamp) + faucet.REQUEST_COOLDOWN();

        vm.expectEmit(true, true, false, true, address(faucet));
        emit SowmorrowTestStockFaucet.FixtureMinted(fixtureOne, claimer, 10 ether, expectedAvailableAt);
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, 10 ether);

        assertEq(IB20(fixtureOne).balanceOf(claimer), 10 ether);
        assertEq(faucet.nextRequestAt(claimer), expectedAvailableAt);
    }

    function test_requestFixture_mintsExactlyTheCap() public {
        uint256 cap = faucet.MAX_REQUEST_RAW();
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, cap);
        assertEq(IB20(fixtureOne).balanceOf(claimer), 100 ether);
    }

    function test_requestFixture_revertsAboveTheCap() public {
        vm.expectRevert(
            abi.encodeWithSelector(SowmorrowTestStockFaucet.RequestAmountTooLarge.selector, 100 ether + 1, 100 ether)
        );
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, 100 ether + 1);
    }

    function test_requestFixture_revertsForZeroAmount() public {
        vm.expectRevert(SowmorrowTestStockFaucet.RequestAmountZero.selector);
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, 0);
    }

    function test_requestFixture_revertsForUnsupportedFixture() public {
        address unsupported = _createAsset(
            admin,
            keccak256("unsupported"),
            _assetParams("Sowmorrow Test Stock Nine", "SMT9", admin, 18),
            new bytes[](0)
        );
        vm.expectRevert(abi.encodeWithSelector(SowmorrowTestStockFaucet.FixtureUnsupported.selector, unsupported));
        vm.prank(claimer);
        faucet.requestFixture(unsupported, 1 ether);
    }

    function test_requestFixture_revertsWhileTheCooldownIsActive() public {
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, 1 ether);
        uint64 availableAt = faucet.nextRequestAt(claimer);

        vm.warp(uint256(availableAt) - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowTestStockFaucet.RequestCooldownActive.selector, claimer, availableAt, block.timestamp
            )
        );
        vm.prank(claimer);
        faucet.requestFixture(fixtureTwo, 1 ether);
    }

    function test_requestFixture_succeedsWhenTheCooldownExpires() public {
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, 1 ether);

        vm.warp(uint256(faucet.nextRequestAt(claimer)));
        vm.prank(claimer);
        faucet.requestFixture(fixtureTwo, 2 ether);

        assertEq(IB20(fixtureTwo).balanceOf(claimer), 2 ether);
    }

    function test_requestFixture_cooldownIsPerAddress() public {
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, 1 ether);

        vm.prank(otherClaimer);
        faucet.requestFixture(fixtureOne, 3 ether);

        assertEq(IB20(fixtureOne).balanceOf(otherClaimer), 3 ether);
        assertEq(faucet.nextRequestAt(otherClaimer), uint64(block.timestamp) + faucet.REQUEST_COOLDOWN());
    }

    function test_requestFixture_revertsOnBaseMainnet() public {
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(SowmorrowTestStockFaucet.FaucetChainForbidden.selector, 8453));
        vm.prank(claimer);
        faucet.requestFixture(fixtureOne, 1 ether);
    }

    function test_requestFixture_revertsWithoutTheMintRole() public {
        address ungranted = _createAsset(
            admin, keccak256("ungranted"), _assetParams("Sowmorrow Test Stock Ten", "SMT10", admin, 18), new bytes[](0)
        );
        address[] memory set = new address[](1);
        set[0] = ungranted;
        SowmorrowTestStockFaucet ungrantedFaucet = new SowmorrowTestStockFaucet(set);

        vm.expectRevert(
            abi.encodeWithSelector(
                IB20.AccessControlUnauthorizedAccount.selector, address(ungrantedFaucet), B20Constants.MINT_ROLE
            )
        );
        vm.prank(claimer);
        ungrantedFaucet.requestFixture(ungranted, 1 ether);
    }

    function testFuzz_requestFixture_neverExceedsTheCapOrSkipsTheCooldown(address account, uint256 amountRaw) public {
        vm.assume(account != address(0) && account != address(faucet));
        amountRaw = bound(amountRaw, 1, faucet.MAX_REQUEST_RAW());

        vm.prank(account);
        faucet.requestFixture(fixtureOne, amountRaw);
        assertEq(IB20(fixtureOne).balanceOf(account), amountRaw);

        uint64 availableAt = faucet.nextRequestAt(account);
        assertEq(availableAt, uint64(block.timestamp) + faucet.REQUEST_COOLDOWN());
        vm.expectRevert(
            abi.encodeWithSelector(
                SowmorrowTestStockFaucet.RequestCooldownActive.selector, account, availableAt, block.timestamp
            )
        );
        vm.prank(account);
        faucet.requestFixture(fixtureOne, amountRaw);
    }
}
