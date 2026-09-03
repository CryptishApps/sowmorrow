// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface ISowmorrowReentryTarget {
    function createGift(address stock, address recipient, uint256 amountRaw, uint64 unlockAt, bytes32 noteHash)
        external
        returns (uint256 giftId);

    function claim(uint256 giftId) external;
}

contract AdversarialB20 {
    enum Mode {
        Normal,
        ReturnFalse,
        UnderTransfer,
        OverTransfer,
        EmptyReturn,
        Reenter,
        RevertBalance
    }

    mapping(address account => uint256 amount) private balances;

    address private targetVault;
    address private configuredRecipient;
    uint256 private configuredGiftId;
    Mode private configuredMode;

    bool public lastReentrySucceeded;
    bytes4 public lastReentrySelector;

    error BalanceReadFailed();

    function configure(
        address vault,
        address sender,
        address recipient,
        uint256 senderBalance,
        uint256 vaultBalance,
        uint256 giftId,
        Mode mode
    ) external {
        targetVault = vault;
        configuredRecipient = recipient;
        configuredGiftId = giftId;
        configuredMode = mode;
        balances[sender] = senderBalance;
        balances[vault] = vaultBalance;
        balances[recipient] = 0;
        lastReentrySucceeded = false;
        lastReentrySelector = bytes4(0);
    }

    function balanceOf(address account) external view returns (uint256) {
        if (configuredMode == Mode.RevertBalance) revert BalanceReadFailed();
        return balances[account];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFromWithMemo(address from, address to, uint256 amount, bytes32) external returns (bool) {
        if (configuredMode == Mode.ReturnFalse) return false;
        if (configuredMode == Mode.EmptyReturn) {
            assembly {
                return(0, 0)
            }
        }
        if (configuredMode == Mode.Reenter) _reenterCreate();

        uint256 moved = amount;
        if (configuredMode == Mode.UnderTransfer) moved = amount - 1;
        if (configuredMode == Mode.OverTransfer) moved = amount + 1;
        _move(from, to, moved);
        return true;
    }

    function transferWithMemo(address to, uint256 amount, bytes32) external returns (bool) {
        if (configuredMode == Mode.ReturnFalse) return false;
        if (configuredMode == Mode.EmptyReturn) {
            assembly {
                return(0, 0)
            }
        }
        if (configuredMode == Mode.Reenter) _reenterClaim();
        if (configuredMode == Mode.OverTransfer) {
            balances[msg.sender] += 1;
            balances[to] += amount;
            return true;
        }

        uint256 moved = configuredMode == Mode.UnderTransfer ? amount - 1 : amount;
        _move(msg.sender, to, moved);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        balances[from] -= amount;
        balances[to] += amount;
    }

    function _reenterCreate() private {
        (bool succeeded, bytes memory returnData) = targetVault.call(
            abi.encodeCall(
                ISowmorrowReentryTarget.createGift,
                (address(this), configuredRecipient, 1, uint64(block.timestamp + 1), bytes32(0))
            )
        );
        _recordReentry(succeeded, returnData);
    }

    function _reenterClaim() private {
        (bool succeeded, bytes memory returnData) =
            targetVault.call(abi.encodeCall(ISowmorrowReentryTarget.claim, (configuredGiftId)));
        _recordReentry(succeeded, returnData);
    }

    function _recordReentry(bool succeeded, bytes memory returnData) private {
        lastReentrySucceeded = succeeded;
        if (returnData.length >= 4) {
            bytes4 selector;
            assembly {
                selector := mload(add(returnData, 32))
            }
            lastReentrySelector = selector;
        }
    }
}

contract AssetProbe {
    uint256 private precision;
    uint256 private multiplierValue;

    function setValues(uint256 newPrecision, uint256 newMultiplier) external {
        precision = newPrecision;
        multiplierValue = newMultiplier;
    }

    function WAD_PRECISION() external view returns (uint256) {
        return precision;
    }

    function multiplier() external view returns (uint256) {
        return multiplierValue;
    }
}

contract EmptyAssetProbe { }

contract MultiplierRevertProbe {
    error MultiplierCallFailed();

    function WAD_PRECISION() external pure returns (uint256) {
        return 1 ether;
    }

    function multiplier() external pure returns (uint256) {
        revert MultiplierCallFailed();
    }
}

contract ForceEther {
    constructor() payable { }

    function sendTo(address payable recipient) external {
        selfdestruct(recipient);
    }
}
