// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IShared.sol";

event PublisherRegistered(address indexed publisher, uint128 shMonStaked, uint128 monValue);
event PublisherToppedUp(address indexed publisher, uint128 added, uint128 newTotal);
event UnbondingStarted(address indexed publisher, uint48 unbondingEndsAt);
event WithdrawalCompleted(address indexed publisher, uint128 shMonReturned);
event PublisherSlashed(address indexed publisher, address indexed watchdog, uint128 shMonSlashed, uint128 watchdogBounty, uint128 burned);
event PublisherBanned(address indexed publisher, uint32 slashCount);

error AlreadyRegistered(address publisher);
error NotRegistered(address publisher);
error InsufficientStake(uint128 provided, uint128 required);
error NotAdjudicator(address caller);
error StillUnbonding(uint48 endsAt, uint48 current);
error NotUnbonding(address publisher);
error PublisherIsBanned(address publisher);
error ZeroAmount();

contract PublisherStake {

    uint48  public constant UNBONDING_PERIOD    = 7 days;
    uint32  public constant SLASH_BAN_THRESHOLD = 3;
    uint16  public constant DEFAULT_BOUNTY_BPS  = 2_000;
    uint256 public constant RATE_SCALE          = 1e18;

    IShMON  public immutable shMon;

    address public adjudicator;
    uint128 public minStakeMon;
    uint16  public watchdogBountyBps;

    mapping(address => PublisherInfo) private _publishers;
    address[]                         private _publisherList;
    mapping(address => bool)          private _inList;

    constructor(address _shMon, address _adjudicator, uint128 _minStakeMon) {
        shMon             = IShMON(_shMon);
        adjudicator       = _adjudicator;
        minStakeMon       = _minStakeMon;
        watchdogBountyBps = DEFAULT_BOUNTY_BPS;
    }

    function setAdjudicator(address _adjudicator) external {
        require(adjudicator == address(0), "Adjudicator already set");
        adjudicator = _adjudicator;
    }

    function register(uint128 shMonAmount) external {
        if (shMonAmount == 0) revert ZeroAmount();
        PublisherInfo storage info = _publishers[msg.sender];
        if (info.status == PublisherStatus.Banned)  revert PublisherIsBanned(msg.sender);
        if (info.status == PublisherStatus.Active)  revert AlreadyRegistered(msg.sender);

        uint256 rate     = shMon.exchangeRate();
        uint128 monValue = _toMonValue(shMonAmount, rate);
        if (monValue < minStakeMon) revert InsufficientStake(monValue, minStakeMon);

        shMon.transferFrom(msg.sender, address(this), shMonAmount);

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

    function topUp(uint128 shMonAmount) external {
        if (shMonAmount == 0) revert ZeroAmount();
        PublisherInfo storage info = _publishers[msg.sender];
        if (info.status == PublisherStatus.Unregistered) revert NotRegistered(msg.sender);
        if (info.status == PublisherStatus.Banned)       revert PublisherIsBanned(msg.sender);

        shMon.transferFrom(msg.sender, address(this), shMonAmount);
        info.shMonStaked    += shMonAmount;
        info.unbondingEndsAt = 0;
        if (info.status != PublisherStatus.Active) info.status = PublisherStatus.Active;
        emit PublisherToppedUp(msg.sender, shMonAmount, info.shMonStaked);
    }

    function startUnbonding() external {
        PublisherInfo storage info = _publishers[msg.sender];
        if (info.status != PublisherStatus.Active && info.status != PublisherStatus.Slashed) {
            revert NotRegistered(msg.sender);
        }
        info.status          = PublisherStatus.Unbonding;
        info.unbondingEndsAt = uint48(block.timestamp) + UNBONDING_PERIOD;
        emit UnbondingStarted(msg.sender, info.unbondingEndsAt);
    }

    function withdraw() external {
        PublisherInfo storage info = _publishers[msg.sender];
        if (info.status != PublisherStatus.Unbonding) revert NotUnbonding(msg.sender);
        if (block.timestamp < info.unbondingEndsAt)   revert StillUnbonding(info.unbondingEndsAt, uint48(block.timestamp));

        uint128 amount   = info.shMonStaked;
        info.shMonStaked = 0;
        info.status      = PublisherStatus.Unregistered;
        shMon.transfer(msg.sender, amount);
        emit WithdrawalCompleted(msg.sender, amount);
    }

    function slash(address publisher, uint128 slashMonAmount, address watchdog) external {
        if (msg.sender != adjudicator) revert NotAdjudicator(msg.sender);
        PublisherInfo storage info = _publishers[publisher];
        if (info.status == PublisherStatus.Unregistered) revert NotRegistered(publisher);
        if (info.status == PublisherStatus.Banned)       revert PublisherIsBanned(publisher);

        uint256 rate         = shMon.exchangeRate();
        uint128 shMonToSlash = _toShMonAmount(slashMonAmount, rate);
        if (shMonToSlash > info.shMonStaked) shMonToSlash = info.shMonStaked;

        uint128 bounty = uint128((uint256(shMonToSlash) * watchdogBountyBps) / 10_000);
        uint128 toBurn = shMonToSlash - bounty;

        info.shMonStaked -= shMonToSlash;
        info.slashCount  += 1;

        if (info.slashCount >= SLASH_BAN_THRESHOLD) {
            info.status = PublisherStatus.Banned;
            if (info.shMonStaked > 0) {
                toBurn          += info.shMonStaked;
                info.shMonStaked = 0;
            }
            emit PublisherBanned(publisher, info.slashCount);
        } else {
            uint128 remainingMon = _toMonValue(info.shMonStaked, rate);
            if (remainingMon < minStakeMon) info.status = PublisherStatus.Slashed;
        }

        if (bounty > 0) shMon.transfer(watchdog, bounty);
        if (toBurn  > 0) shMon.burn(toBurn);
        emit PublisherSlashed(publisher, watchdog, shMonToSlash, bounty, toBurn);
    }

    function isAuthorised(address publisher) external view returns (bool) {
        return _publishers[publisher].status == PublisherStatus.Active;
    }

    function getPublisher(address publisher) external view returns (PublisherInfo memory) {
        return _publishers[publisher];
    }

    function currentMonValue(address publisher) external view returns (uint128) {
        return _toMonValue(_publishers[publisher].shMonStaked, shMon.exchangeRate());
    }

    function getAllPublishers() external view returns (address[] memory) { return _publisherList; }

    function activePublisherCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < _publisherList.length; i++) {
            if (_publishers[_publisherList[i]].status == PublisherStatus.Active) count++;
        }
    }

    function _toMonValue(uint128 shMonAmount, uint256 rate) internal pure returns (uint128) {
        return uint128((uint256(shMonAmount) * rate) / RATE_SCALE);
    }

    function _toShMonAmount(uint128 monAmount, uint256 rate) internal pure returns (uint128) {
        return uint128((uint256(monAmount) * RATE_SCALE) / rate);
    }
}
