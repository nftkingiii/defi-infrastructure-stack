// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PublisherStake
 * @notice Gates write access to ScoreRegistry via shMON collateral.
 *
 * Design:
 *  - Publishers deposit shMON to register.
 *  - Minimum stake is denominated in MON value, computed at deposit time
 *    using the live shMON/MON exchange rate from the shMON contract.
 *  - Publishers earn shMON yield on locked collateral (MEV-enhanced APY).
 *  - Slash is triggered by the DeviationAdjudicator only.
 *  - Slashed shMON is split: bounty to watchdog caller, remainder burned.
 *  - Unbonding period prevents immediate withdrawal after slashing window.
 *  - Exchange rate is recomputed at slash time to ensure MON-denominated
 *    slash amounts remain accurate regardless of shMON appreciation.
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IShMON {
    /**
     * @notice Returns how much MON one unit of shMON is worth.
     *         Scaled to 1e18. E.g. 1.05e18 means 1 shMON = 1.05 MON.
     */
    function exchangeRate() external view returns (uint256);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

// ── Types ─────────────────────────────────────────────────────────────────────

enum PublisherStatus {
    Unregistered,  // 0 — never staked
    Active,        // 1 — staked and authorised
    Unbonding,     // 2 — withdrawal requested, waiting out unbonding period
    Slashed,       // 3 — collateral reduced by adjudicator, may still be active
    Banned         // 4 — repeated slashes, removed from registry
}

struct PublisherInfo {
    uint128        shMonStaked;       // shMON units currently locked
    uint128        monValueAtDeposit; // MON value when staked (1e18 scaled)
    uint48         stakedAt;          // timestamp of most recent deposit
    uint48         unbondingEndsAt;   // 0 if not unbonding
    uint32         slashCount;        // lifetime slash counter
    uint32         poolsPublished;    // number of unique pools this publisher writes
    PublisherStatus status;
}

// ── Events ────────────────────────────────────────────────────────────────────

event PublisherRegistered(address indexed publisher, uint128 shMonStaked, uint128 monValue);
event PublisherToppedUp(address indexed publisher, uint128 added, uint128 newTotal);
event UnbondingStarted(address indexed publisher, uint48 unbondingEndsAt);
event WithdrawalCompleted(address indexed publisher, uint128 shMonReturned);
event PublisherSlashed(
    address indexed publisher,
    address indexed watchdog,
    uint128 shMonSlashed,
    uint128 watchdogBounty,
    uint128 burned
);
event PublisherBanned(address indexed publisher, uint32 slashCount);
event AdjudicatorUpdated(address indexed oldAdjudicator, address indexed newAdjudicator);
event MinStakeUpdated(uint128 oldMin, uint128 newMin);

// ── Errors ────────────────────────────────────────────────────────────────────

error AlreadyRegistered(address publisher);
error NotRegistered(address publisher);
error InsufficientStake(uint128 provided, uint128 required);
error NotAdjudicator(address caller);
error StillUnbonding(uint48 endsAt, uint48 current);
error NotUnbonding(address publisher);
error PublisherIsBanned(address publisher);
error ZeroAmount();
error InvalidBountyBps(uint16 bps);

// ── Contract ──────────────────────────────────────────────────────────────────

contract PublisherStake {

    // ── Constants ─────────────────────────────────────────────────────────────

    uint48  public constant UNBONDING_PERIOD   = 7 days;
    uint32  public constant SLASH_BAN_THRESHOLD = 3;      // bans after 3 slashes
    uint16  public constant MAX_BOUNTY_BPS      = 3_000;  // watchdog gets max 30% of slash
    uint16  public constant DEFAULT_BOUNTY_BPS  = 2_000;  // default 20%
    uint256 public constant RATE_SCALE          = 1e18;

    // ── Immutables ────────────────────────────────────────────────────────────

    IShMON public immutable shMon;

    // ── State ─────────────────────────────────────────────────────────────────

    address public adjudicator;          // DeviationAdjudicator contract
    uint128 public minStakeMon;          // minimum stake in MON terms (1e18 scaled)
    uint16  public watchdogBountyBps;    // basis points of slash sent to watchdog

    mapping(address => PublisherInfo) private _publishers;
    address[] private _publisherList;
    mapping(address => bool) private _inList;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _shMon          shMON token contract address
     * @param _adjudicator    DeviationAdjudicator contract address
     * @param _minStakeMon    Minimum stake in MON value, 1e18 scaled
     *                        e.g. 1000e18 = 1000 MON minimum
     */
    constructor(
        address _shMon,
        address _adjudicator,
        uint128 _minStakeMon
    ) {
        shMon             = IShMON(_shMon);
        adjudicator       = _adjudicator;
        minStakeMon       = _minStakeMon;
        watchdogBountyBps = DEFAULT_BOUNTY_BPS;
    }

    // ── Publisher Registration ────────────────────────────────────────────────

    /**
     * @notice Stake shMON to register as a publisher.
     * @param  shMonAmount  Amount of shMON to deposit.
     *                      Must be worth at least minStakeMon at current rate.
     */
    function register(uint128 shMonAmount) external {
        if (shMonAmount == 0) revert ZeroAmount();

        PublisherInfo storage info = _publishers[msg.sender];

        if (info.status == PublisherStatus.Banned) {
            revert PublisherIsBanned(msg.sender);
        }
        if (info.status == PublisherStatus.Active) {
            revert AlreadyRegistered(msg.sender);
        }

        // ── Check MON-denominated minimum
        uint256 rate     = shMon.exchangeRate();                    // shMON/MON rate, 1e18
        uint128 monValue = _toMonValue(shMonAmount, rate);

        if (monValue < minStakeMon) {
            revert InsufficientStake(monValue, minStakeMon);
        }

        // ── Pull shMON from publisher
        shMon.transferFrom(msg.sender, address(this), shMonAmount);

        // ── Record
        info.shMonStaked       = shMonAmount;
        info.monValueAtDeposit = monValue;
        info.stakedAt          = uint48(block.timestamp);
        info.unbondingEndsAt   = 0;
        info.status            = PublisherStatus.Active;

        if (!_inList[msg.sender]) {
            _publisherList.push(msg.sender);
            _inList[msg.sender] = true;
        }

        emit PublisherRegistered(msg.sender, shMonAmount, monValue);
    }

    /**
     * @notice Add more shMON to an existing stake.
     * @dev    Resets unbonding if publisher was in Unbonding state.
     */
    function topUp(uint128 shMonAmount) external {
        if (shMonAmount == 0) revert ZeroAmount();

        PublisherInfo storage info = _publishers[msg.sender];
        if (info.status == PublisherStatus.Unregistered) revert NotRegistered(msg.sender);
        if (info.status == PublisherStatus.Banned)       revert PublisherIsBanned(msg.sender);

        shMon.transferFrom(msg.sender, address(this), shMonAmount);

        info.shMonStaked     += shMonAmount;
        info.unbondingEndsAt  = 0;

        // Restore to Active if they were unbonding or slashed
        if (info.status != PublisherStatus.Active) {
            info.status = PublisherStatus.Active;
        }

        emit PublisherToppedUp(msg.sender, shMonAmount, info.shMonStaked);
    }

    // ── Withdrawal ────────────────────────────────────────────────────────────

    /**
     * @notice Initiate unbonding. Publisher loses authorisation immediately.
     *         Must wait UNBONDING_PERIOD before calling withdraw().
     */
    function startUnbonding() external {
        PublisherInfo storage info = _publishers[msg.sender];
        if (info.status != PublisherStatus.Active && info.status != PublisherStatus.Slashed) {
            revert NotRegistered(msg.sender);
        }

        info.status          = PublisherStatus.Unbonding;
        info.unbondingEndsAt = uint48(block.timestamp) + UNBONDING_PERIOD;

        emit UnbondingStarted(msg.sender, info.unbondingEndsAt);
    }

    /**
     * @notice Withdraw staked shMON after unbonding period.
     *         Publisher receives full shMON balance including accrued yield.
     */
    function withdraw() external {
        PublisherInfo storage info = _publishers[msg.sender];

        if (info.status != PublisherStatus.Unbonding) revert NotUnbonding(msg.sender);
        if (block.timestamp < info.unbondingEndsAt) {
            revert StillUnbonding(info.unbondingEndsAt, uint48(block.timestamp));
        }

        uint128 amount    = info.shMonStaked;
        info.shMonStaked  = 0;
        info.status       = PublisherStatus.Unregistered;

        shMon.transfer(msg.sender, amount);

        emit WithdrawalCompleted(msg.sender, amount);
    }

    // ── Slashing ──────────────────────────────────────────────────────────────

    /**
     * @notice Slash a publisher's stake.
     * @dev    Only callable by the DeviationAdjudicator.
     *         Slash amount is computed in MON terms at current exchange rate
     *         so the real-value penalty is consistent regardless of shMON yield.
     *
     * @param publisher      Address to slash
     * @param slashMonAmount Slash amount in MON terms (1e18 scaled)
     * @param watchdog       Address that triggered the slash — receives bounty
     */
    function slash(
        address publisher,
        uint128 slashMonAmount,
        address watchdog
    ) external {
        if (msg.sender != adjudicator) revert NotAdjudicator(msg.sender);

        PublisherInfo storage info = _publishers[publisher];
        if (info.status == PublisherStatus.Unregistered) revert NotRegistered(publisher);
        if (info.status == PublisherStatus.Banned)       revert PublisherIsBanned(publisher);

        // ── Convert MON slash amount to shMON at current rate
        uint256 rate           = shMon.exchangeRate();
        uint128 shMonToSlash   = _toShMonAmount(slashMonAmount, rate);

        // ── Cap at available balance
        if (shMonToSlash > info.shMonStaked) {
            shMonToSlash = info.shMonStaked;
        }

        // ── Split: bounty to watchdog, remainder burned
        uint128 bounty  = uint128((uint256(shMonToSlash) * watchdogBountyBps) / 10_000);
        uint128 toBurn  = shMonToSlash - bounty;

        info.shMonStaked -= shMonToSlash;
        info.slashCount  += 1;

        // ── Ban if slash threshold reached
        if (info.slashCount >= SLASH_BAN_THRESHOLD) {
            info.status = PublisherStatus.Banned;
            // Burn remaining stake on ban
            if (info.shMonStaked > 0) {
                toBurn           += info.shMonStaked;
                info.shMonStaked  = 0;
            }
            emit PublisherBanned(publisher, info.slashCount);
        } else {
            // Check if remaining stake still meets minimum
            uint128 remainingMon = _toMonValue(info.shMonStaked, rate);
            if (remainingMon < minStakeMon) {
                info.status = PublisherStatus.Slashed; // loses authorisation
            }
        }

        // ── Distribute
        if (bounty > 0) shMon.transfer(watchdog, bounty);
        if (toBurn  > 0) shMon.burn(toBurn);

        emit PublisherSlashed(publisher, watchdog, shMonToSlash, bounty, toBurn);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns whether an address is authorised to publish scores.
     *         Called by ScoreRegistry on every publishScore() call.
     */
    function isAuthorised(address publisher) external view returns (bool) {
        return _publishers[publisher].status == PublisherStatus.Active;
    }

    /**
     * @notice Returns full publisher info.
     */
    function getPublisher(address publisher)
        external
        view
        returns (PublisherInfo memory)
    {
        return _publishers[publisher];
    }

    /**
     * @notice Returns the current MON value of a publisher's staked shMON.
     *         Reflects yield accrued since deposit.
     */
    function currentMonValue(address publisher)
        external
        view
        returns (uint128)
    {
        PublisherInfo storage info = _publishers[publisher];
        uint256 rate = shMon.exchangeRate();
        return _toMonValue(info.shMonStaked, rate);
    }

    /**
     * @notice Returns all registered publisher addresses.
     */
    function getAllPublishers() external view returns (address[] memory) {
        return _publisherList;
    }

    /**
     * @notice Returns count of active publishers.
     */
    function activePublisherCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < _publisherList.length; i++) {
            if (_publishers[_publisherList[i]].status == PublisherStatus.Active) {
                count++;
            }
        }
    }

    // ── Math Helpers ──────────────────────────────────────────────────────────

    /**
     * @dev Converts shMON amount to MON value using live exchange rate.
     *      rate is shMON/MON, scaled 1e18.
     *      monValue = shMonAmount * rate / 1e18
     */
    function _toMonValue(uint128 shMonAmount, uint256 rate)
        internal
        pure
        returns (uint128)
    {
        return uint128((uint256(shMonAmount) * rate) / RATE_SCALE);
    }

    /**
     * @dev Converts a MON amount to shMON units at current rate.
     *      shMonAmount = monAmount * 1e18 / rate
     */
    function _toShMonAmount(uint128 monAmount, uint256 rate)
        internal
        pure
        returns (uint128)
    {
        return uint128((uint256(monAmount) * RATE_SCALE) / rate);
    }
}
