// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockShMON
 * @notice Mock shMON token for testnet publisher registration.
 *         Mimics the shMON interface used by PublisherStake.
 *         Anyone can mint — testnet only, never deploy to mainnet.
 */
contract MockShMON {

    string  public name     = "Mock shMONAD";
    string  public symbol   = "shMON";
    uint8   public decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Fixed exchange rate: 1 shMON = 1.05 MON (1.05e18)
    // Matches the mock used in tests
    uint256 public exchangeRate = 1.05e18;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Burned(address indexed from, uint256 amount);

    // ── Faucet — anyone can mint on testnet ───────────────────────────────────

    function mint(address to, uint256 amount) external {
        totalSupply    += amount;
        balanceOf[to]  += amount;
        emit Transfer(address(0), to, amount);
    }

    // ── ERC20 ─────────────────────────────────────────────────────────────────

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount,              "insufficient balance");
        require(allowance[from][msg.sender] >= amount,  "insufficient allowance");
        balanceOf[from]              -= amount;
        allowance[from][msg.sender]  -= amount;
        balanceOf[to]                += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    // ── shMON-specific ────────────────────────────────────────────────────────

    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        totalSupply           -= amount;
        emit Burned(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
    }

    function setExchangeRate(uint256 newRate) external {
        exchangeRate = newRate;
    }
}
