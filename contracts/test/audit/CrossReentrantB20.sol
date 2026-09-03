// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IVaultReentry {
    function createGift(address stock, address recipient, uint256 amountRaw, uint64 unlockAt, bytes32 noteHash)
        external
        returns (uint256 giftId);
    function claim(uint256 giftId) external;
    function claimMany(uint256[] calldata giftIds) external;
}

/// Token double whose transfer hooks reenter a DIFFERENT vault entry point than the one that
/// called it, to probe cross-function reentrancy.
contract CrossReentrantB20 {
    enum Target {
        None,
        Claim,
        ClaimMany,
        CreateGift
    }

    mapping(address account => uint256 amount) private balances;

    address private vault;
    address private beneficiary;
    uint256 private giftId;
    Target private onTransferFrom;
    Target private onTransfer;

    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes4 public reentrySelector;

    function configure(
        address vault_,
        address depositor,
        address beneficiary_,
        uint256 depositorBalance,
        uint256 vaultBalance,
        uint256 giftId_,
        Target onTransferFrom_,
        Target onTransfer_
    ) external {
        vault = vault_;
        beneficiary = beneficiary_;
        giftId = giftId_;
        onTransferFrom = onTransferFrom_;
        onTransfer = onTransfer_;
        balances[depositor] = depositorBalance;
        balances[vault_] = vaultBalance;
        balances[beneficiary_] = 0;
        reentryAttempted = false;
        reentrySucceeded = false;
        reentrySelector = bytes4(0);
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function transferFromWithMemo(address from, address to, uint256 amount, bytes32) external returns (bool) {
        _reenter(onTransferFrom);
        balances[from] -= amount;
        balances[to] += amount;
        return true;
    }

    function transferWithMemo(address to, uint256 amount, bytes32) external returns (bool) {
        _reenter(onTransfer);
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function _reenter(Target target) private {
        if (target == Target.None) return;
        reentryAttempted = true;
        bytes memory payload;
        if (target == Target.Claim) {
            payload = abi.encodeCall(IVaultReentry.claim, (giftId));
        } else if (target == Target.ClaimMany) {
            uint256[] memory ids = new uint256[](1);
            ids[0] = giftId;
            payload = abi.encodeCall(IVaultReentry.claimMany, (ids));
        } else {
            payload = abi.encodeCall(
                IVaultReentry.createGift, (address(this), beneficiary, 1, uint64(block.timestamp + 1), bytes32(0))
            );
        }
        (bool ok, bytes memory data) = vault.call(payload);
        reentrySucceeded = ok;
        if (data.length >= 4) {
            bytes4 selector;
            assembly {
                selector := mload(add(data, 32))
            }
            reentrySelector = selector;
        }
    }
}

/// Recipient/sender double that records whether the token ever handed control back to it.
contract CallbackProbe {
    bool public touched;

    function approve(address token, address spender) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok, "approve failed");
    }

    function createGift(address vault, address stock, address recipient, uint256 amount, uint64 unlockAt)
        external
        returns (uint256)
    {
        return IVaultReentry(vault).createGift(stock, recipient, amount, unlockAt, bytes32(0));
    }

    function claim(address vault, uint256 giftId) external {
        IVaultReentry(vault).claim(giftId);
    }

    fallback() external payable {
        touched = true;
    }

    receive() external payable {
        touched = true;
    }
}

/// Contract that can hold tokens but has no code path that can ever call `claim`.
contract InertRecipient { }
