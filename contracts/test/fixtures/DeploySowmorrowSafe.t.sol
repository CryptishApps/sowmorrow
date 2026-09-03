// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { DeploySowmorrow } from "../../script/DeploySowmorrow.s.sol";

/// @notice Minimal stand-in for the Safe signer-policy API the mainnet deployment reads.
contract MockSafe {
    uint256 private threshold;
    address[] private owners;

    constructor(uint256 initialThreshold, address[] memory initialOwners) {
        threshold = initialThreshold;
        owners = initialOwners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }
}

/// @notice A contract that answers neither Safe accessor.
contract NotASafe {
    uint256 public unrelated = 1;
}

/// @notice A contract whose threshold accessor reverts.
contract RevertingThresholdSafe {
    function getThreshold() external pure returns (uint256) {
        revert("no threshold");
    }

    function getOwners() external pure returns (address[] memory) {
        return new address[](3);
    }
}

/// @notice A contract that reports a threshold but no owner set.
contract ThresholdOnlySafe {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }
}

contract DeploySowmorrowSafeTest is Test {
    DeploySowmorrow internal deployment;
    address internal signerOne = makeAddr("safe-signer-one");
    address internal signerTwo = makeAddr("safe-signer-two");
    address internal signerThree = makeAddr("safe-signer-three");

    function setUp() public {
        deployment = new DeploySowmorrow();
    }

    function _signers(uint256 count) internal view returns (address[] memory signers) {
        address[3] memory pool = [signerOne, signerTwo, signerThree];
        signers = new address[](count);
        for (uint256 index = 0; index < count; ++index) {
            signers[index] = pool[index % 3];
        }
    }

    function _safe(uint256 threshold, address[] memory owners) internal returns (address) {
        return address(new MockSafe(threshold, owners));
    }

    function test_requireReviewedSafe_acceptsTwoOfThree() public {
        deployment.requireReviewedSafe(_safe(2, _signers(3)));
    }

    function test_requireReviewedSafe_acceptsThreeOfThree() public {
        deployment.requireReviewedSafe(_safe(3, _signers(3)));
    }

    function test_requireReviewedSafe_rejectsAnEoa() public {
        address eoa = makeAddr("deployer-eoa");
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerMustBeContract.selector, eoa));
        deployment.requireReviewedSafe(eoa);
    }

    function test_requireReviewedSafe_rejectsAContractWithoutTheSafeApi() public {
        address owner = address(new NotASafe());
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerNotSafe.selector, owner));
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsARevertingThresholdAccessor() public {
        address owner = address(new RevertingThresholdSafe());
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerNotSafe.selector, owner));
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsAMissingOwnerAccessor() public {
        address owner = address(new ThresholdOnlySafe());
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerNotSafe.selector, owner));
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsASingleSignatureThreshold() public {
        address owner = _safe(1, _signers(3));
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerThresholdTooLow.selector, owner, 1, 2));
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsTwoSigners() public {
        address owner = _safe(2, _signers(2));
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerSignerSetTooSmall.selector, owner, 2, 3));
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsAnUnreachableThreshold() public {
        address owner = _safe(4, _signers(3));
        vm.expectRevert(
            abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerThresholdExceedsSigners.selector, owner, 4, 3)
        );
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsAZeroSigner() public {
        address[] memory signers = _signers(3);
        signers[2] = address(0);
        address owner = _safe(2, signers);
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerSignerInvalid.selector, owner, address(0)));
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsASelfOwningSafe() public {
        address[] memory signers = _signers(3);
        address owner = _safe(2, signers);
        address[] memory selfOwning = _signers(3);
        selfOwning[1] = owner;
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerSignerInvalid.selector, owner, owner));
        vm.mockCall(owner, abi.encodeWithSignature("getOwners()"), abi.encode(selfOwning));
        deployment.requireReviewedSafe(owner);
    }

    function test_requireReviewedSafe_rejectsDuplicateSigners() public {
        address[] memory signers = new address[](3);
        signers[0] = signerOne;
        signers[1] = signerTwo;
        signers[2] = signerOne;
        address owner = _safe(2, signers);
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerSignerDuplicated.selector, owner, signerOne));
        deployment.requireReviewedSafe(owner);
    }

    /// @dev `vm.setEnv` mutates the shared process environment, so every `run()` scenario lives in a
    ///      single sequential test rather than racing sibling tests in the same suite.
    function test_run_rejectsEveryMisconfiguredMainnetOwner() public {
        vm.chainId(1);
        vm.setEnv("SOWMORROW_OWNER", vm.toString(makeAddr("owner")));
        vm.setEnv("SOWMORROW_START_PAUSED", "false");
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.UnsupportedChain.selector, 1));
        deployment.run();

        vm.chainId(8453);
        address reviewedSafe = _safe(2, _signers(3));
        vm.setEnv("SOWMORROW_OWNER", vm.toString(reviewedSafe));
        vm.expectRevert(DeploySowmorrow.MainnetMustStartPaused.selector);
        deployment.run();

        vm.setEnv("SOWMORROW_START_PAUSED", "true");
        address eoaOwner = makeAddr("mainnet-eoa-owner");
        vm.setEnv("SOWMORROW_OWNER", vm.toString(eoaOwner));
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerMustBeContract.selector, eoaOwner));
        deployment.run();

        address notASafe = address(new NotASafe());
        vm.setEnv("SOWMORROW_OWNER", vm.toString(notASafe));
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerNotSafe.selector, notASafe));
        deployment.run();

        address weakSafe = _safe(1, _signers(3));
        vm.setEnv("SOWMORROW_OWNER", vm.toString(weakSafe));
        vm.expectRevert(abi.encodeWithSelector(DeploySowmorrow.MainnetOwnerThresholdTooLow.selector, weakSafe, 1, 2));
        deployment.run();
    }
}
