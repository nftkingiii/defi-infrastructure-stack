// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IShared.sol";

/**
 * @title PerpsDEX
 * @notice Minimal perpetuals DEX — a research instrument that consumes
 *         PerpRiskParams to derive position limits and margin requirements.
 *
 * Purpose:
 *   Generate empirical data on whether the oracle scoring model is
 *   calibrated correctly. Every liquidation event is logged with the
 *   oracle score active at the time, creating a feedback loop.
 *
 * Design:
 *   - Traders deposit USDC collateral to open long or short positions
 *   - Position size limited by maxOI from PerpRiskParams
 *   - Leverage limited by maxLeverage from PerpRiskParams
 *   - Margin requirements enforced by initialMarginBps / maintenanceMarginBps
 *   - Funding rate accrues every block based on fundingRateMultiplier
 *   - Liquidation fires when margin falls below maintenanceMarginBps
 *   - Liquidator receives liquidationPenaltyBps of position value
 *   - All risk params read atomically from PerpRiskParams on every open
 *
 * Research outputs (emitted as events for off-chain indexing):
 *   - PositionOpened:  params used at open time
 *   - PositionClosed:  PnL, funding paid, duration
 *   - PositionLiquidated: margin at liquidation, score active at time
 *   - FundingAccrued:  running funding rate vs mark price divergence
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IPerpRiskParams {
    function getParams(bytes32 poolId) external returns (RiskParams memory);
    function getCachedParams(bytes32 poolId) external view returns (RiskParams memory);
    function registerPool(bytes32 poolId, uint128 tvlCapUsd) external;
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Events ────────────────────────────────────────────────────────────────────

event PositionOpened(
    uint256 indexed positionId,
    bytes32 indexed poolId,
    address indexed trader,
    Side    side,
    uint128 collateralUsdc,
    uint128 sizeUsdc,
    uint8   leverage,
    uint8   riskScoreAtOpen,
    uint32  entryPrice,
    uint48  timestamp
);

event PositionClosed(
    uint256 indexed positionId,
    address indexed trader,
    int128  pnlUsdc,
    uint128 fundingPaid,
    uint48  duration,
    uint32  exitPrice
);

event PositionLiquidated(
    uint256 indexed positionId,
    address indexed trader,
    address indexed liquidator,
    uint128 collateralSeized,
    uint128 liquidatorBounty,
    uint8   riskScoreAtLiquidation,
    uint48  timestamp
);

event FundingAccrued(
    bytes32 indexed poolId,
    int32   fundingRate,
    uint32  fundingIndex,
    uint48  timestamp
);

event PoolAdded(bytes32 indexed poolId, uint48 timestamp);
event PriceUpdated(bytes32 indexed poolId, uint32 price, uint48 timestamp);

// ── Errors ────────────────────────────────────────────────────────────────────

error PoolNotSupported(bytes32 poolId);
error PositionNotFound(uint256 positionId);
error PositionAlreadyClosed(uint256 positionId);
error NotPositionOwner(uint256 positionId, address caller);
error InsufficientCollateral(uint128 provided, uint128 required);
error ExceedsMaxLeverage(uint8 requested, uint8 max);
error ExceedsMaxOI(uint128 requested, uint128 maxOI);
error PositionNotLiquidatable(uint256 positionId);
error TradingHaltedForPool(bytes32 poolId);
error ZeroSize();
error Unauthorised(address caller);

// ── Contract ──────────────────────────────────────────────────────────────────

contract PerpsDEX {

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant USDC_DECIMALS     = 6;
    uint256 public constant USDC_SCALE        = 1e6;
    uint32  public constant PRICE_SCALE       = 1e4;    // price in bps, 10000 = $1.00
    uint32  public constant FUNDING_SCALE     = 1e6;    // funding index scale
    uint32  public constant BLOCKS_PER_DAY    = 172_800; // ~0.5s blocks

    // ── Immutables ────────────────────────────────────────────────────────────

    IPerpRiskParams public immutable riskParams;
    IERC20          public immutable usdc;
    address         public immutable owner;

    // ── State ─────────────────────────────────────────────────────────────────

    uint256 public positionCount;

    mapping(uint256 => Position)  private _positions;
    mapping(bytes32 => bool)      private _supportedPools;
    mapping(bytes32 => uint32)    private _markPrice;       // poolId => price (bps)
    mapping(bytes32 => uint128)   private _openInterest;    // poolId => total OI (USDC)
    mapping(bytes32 => uint32)    private _fundingIndex;    // poolId => cumulative funding
    mapping(bytes32 => uint48)    private _lastFundingBlock;
    bytes32[]                     private _pools;

    // Research data: tracks liquidation count per oracle score bucket
    // score bucket 0-9 maps to riskScore ranges 0-9, 10-19, ... 90-99
    mapping(uint8 => uint256)     public liquidationsByScoreBucket;
    mapping(uint8 => uint256)     public positionsByScoreBucket;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _riskParams, address _usdc) {
        riskParams = IPerpRiskParams(_riskParams);
        usdc       = IERC20(_usdc);
        owner      = msg.sender;
    }

    // ── Pool Management ───────────────────────────────────────────────────────

    /**
     * @notice Add a pool to the DEX.
     * @dev    Registers pool in PerpRiskParams and sets initial price.
     */
    function addPool(bytes32 poolId, uint32 initialPrice) external {
        if (msg.sender != owner) revert Unauthorised(msg.sender);
        _supportedPools[poolId] = true;
        _markPrice[poolId]      = initialPrice;
        _lastFundingBlock[poolId] = uint48(block.number);
        _pools.push(poolId);
        emit PoolAdded(poolId, uint48(block.timestamp));
    }

    /**
     * @notice Update mark price for a pool.
     * @dev    In production this would be fed by an oracle.
     *         For research purposes the owner updates it manually.
     */
    function updatePrice(bytes32 poolId, uint32 newPrice) external {
        if (msg.sender != owner) revert Unauthorised(msg.sender);
        if (!_supportedPools[poolId]) revert PoolNotSupported(poolId);
        _accrueAllFunding(poolId);
        _markPrice[poolId] = newPrice;
        emit PriceUpdated(poolId, newPrice, uint48(block.timestamp));
    }

    // ── Trading ───────────────────────────────────────────────────────────────

    /**
     * @notice Open a leveraged long or short position.
     * @param poolId         Pool to trade
     * @param side           Long or Short
     * @param collateralUsdc USDC collateral (6 decimals)
     * @param leverage       Leverage multiplier (1-100)
     */
    function openPosition(
        bytes32 poolId,
        Side    side,
        uint128 collateralUsdc,
        uint8   leverage
    ) external returns (uint256 positionId) {
        if (!_supportedPools[poolId]) revert PoolNotSupported(poolId);
        if (collateralUsdc == 0)      revert ZeroSize();

        // ── Read risk params atomically
        RiskParams memory params = riskParams.getParams(poolId);
        if (params.tradingHalted) revert TradingHaltedForPool(poolId);

        // ── Validate leverage
        if (leverage > params.maxLeverage) revert ExceedsMaxLeverage(leverage, params.maxLeverage);
        if (leverage < 1) leverage = 1;

        // ── Compute position size
        uint128 sizeUsdc = uint128(uint256(collateralUsdc) * leverage);

        // ── Validate collateral covers initial margin
        uint128 requiredMargin = uint128(
            (uint256(sizeUsdc) * params.initialMarginBps) / 10_000
        );
        if (collateralUsdc < requiredMargin) {
            revert InsufficientCollateral(collateralUsdc, requiredMargin);
        }

        // ── Validate OI cap
        uint128 newOI = _openInterest[poolId] + sizeUsdc;
        if (newOI > params.maxOI) revert ExceedsMaxOI(newOI, params.maxOI);

        // ── Accrue funding before opening
        _accrueAllFunding(poolId);

        // ── Pull collateral
        usdc.transferFrom(msg.sender, address(this), collateralUsdc);

        // ── Store position
        positionId = ++positionCount;
        _positions[positionId] = Position({
            poolId:                poolId,
            trader:                msg.sender,
            side:                  side,
            collateralUsdc:        collateralUsdc,
            sizeUsdc:              sizeUsdc,
            entryPrice:            _markPrice[poolId],
            entryFundingIndex:     _fundingIndex[poolId],
            leverage:              leverage,
            initialMarginBps:      params.initialMarginBps,
            maintenanceMarginBps:  params.maintenanceMarginBps,
            liquidationPenaltyBps: params.liquidationPenaltyBps,
            riskScoreAtOpen:       params.confidenceUsed,
            openedAt:              uint48(block.timestamp),
            isOpen:                true
        });

        // ── Update OI
        _openInterest[poolId] += sizeUsdc;

        // ── Research tracking
        uint8 bucket = params.confidenceUsed / 10;
        positionsByScoreBucket[bucket]++;

        emit PositionOpened(
            positionId, poolId, msg.sender, side,
            collateralUsdc, sizeUsdc, leverage,
            params.confidenceUsed, _markPrice[poolId],
            uint48(block.timestamp)
        );
    }

    /**
     * @notice Close an open position and settle PnL.
     */
    function closePosition(uint256 positionId) external {
        Position storage pos = _positions[positionId];
        if (pos.openedAt == 0)   revert PositionNotFound(positionId);
        if (!pos.isOpen)          revert PositionAlreadyClosed(positionId);
        if (pos.trader != msg.sender) revert NotPositionOwner(positionId, msg.sender);

        _accrueAllFunding(pos.poolId);

        (int128 pnl, uint128 fundingPaid) = _computePnL(pos);
        uint32 exitPrice = _markPrice[pos.poolId];

        pos.isOpen = false;
        _openInterest[pos.poolId] -= pos.sizeUsdc;

        // Settle: return collateral +/- PnL
        int128 settlement = int128(pos.collateralUsdc) + pnl - int128(fundingPaid);
        if (settlement > 0) {
            usdc.transfer(msg.sender, uint128(settlement));
        }
        // If settlement <= 0 collateral is fully lost (absorbed by DEX)

        emit PositionClosed(
            positionId, msg.sender, pnl, fundingPaid,
            uint48(block.timestamp) - pos.openedAt, exitPrice
        );
    }

    /**
     * @notice Liquidate an undercollateralised position.
     * @dev    Anyone can call. Liquidator receives liquidationPenaltyBps of size.
     */
    function liquidate(uint256 positionId) external {
        Position storage pos = _positions[positionId];
        if (pos.openedAt == 0) revert PositionNotFound(positionId);
        if (!pos.isOpen)        revert PositionAlreadyClosed(positionId);

        _accrueAllFunding(pos.poolId);

        if (!_isLiquidatable(pos)) revert PositionNotLiquidatable(positionId);

        // Read current risk score for research logging
        RiskParams memory params = riskParams.getCachedParams(pos.poolId);

        uint128 bounty = uint128(
            (uint256(pos.sizeUsdc) * pos.liquidationPenaltyBps) / 10_000
        );
        bounty = bounty > pos.collateralUsdc ? pos.collateralUsdc : bounty;

        pos.isOpen = false;
        _openInterest[pos.poolId] -= pos.sizeUsdc;

        // Research tracking — which score bucket generated this liquidation
        uint8 bucket = pos.riskScoreAtOpen / 10;
        liquidationsByScoreBucket[bucket]++;

        usdc.transfer(msg.sender, bounty);

        emit PositionLiquidated(
            positionId, pos.trader, msg.sender,
            pos.collateralUsdc, bounty,
            params.confidenceUsed,
            uint48(block.timestamp)
        );
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getPosition(uint256 positionId) external view returns (Position memory) {
        if (_positions[positionId].openedAt == 0) revert PositionNotFound(positionId);
        return _positions[positionId];
    }

    function getOpenInterest(bytes32 poolId) external view returns (uint128) {
        return _openInterest[poolId];
    }

    function getMarkPrice(bytes32 poolId) external view returns (uint32) {
        return _markPrice[poolId];
    }

    function getFundingIndex(bytes32 poolId) external view returns (uint32) {
        return _fundingIndex[poolId];
    }

    function getSupportedPools() external view returns (bytes32[] memory) {
        return _pools;
    }

    /**
     * @notice Returns liquidation rate per score bucket.
     *         Key research output: high liquidation rate in high-score buckets
     *         means the oracle is over-rating those pools.
     */
    function getLiquidationRate(uint8 bucket)
        external view returns (uint256 liquidations, uint256 positions, uint256 rateBps)
    {
        liquidations = liquidationsByScoreBucket[bucket];
        positions    = positionsByScoreBucket[bucket];
        rateBps      = positions > 0 ? (liquidations * 10_000) / positions : 0;
    }

    function isLiquidatable(uint256 positionId) external view returns (bool) {
        Position storage pos = _positions[positionId];
        if (!pos.isOpen) return false;
        return _isLiquidatable(pos);
    }

    // ── Internal: Funding ─────────────────────────────────────────────────────

    function _accrueAllFunding(bytes32 poolId) internal {
        uint48 lastBlock = _lastFundingBlock[poolId];
        uint48 currBlock = uint48(block.number);
        if (currBlock <= lastBlock) return;

        uint48 blocksDelta = currBlock - lastBlock;

        // Funding rate from cached params: fundingRateMultiplier / BLOCKS_PER_DAY
        // Expressed in FUNDING_SCALE units per block
        RiskParams memory params = riskParams.getCachedParams(poolId);
        uint32 ratePerBlock = params.fundingRateMultiplier / BLOCKS_PER_DAY;

        uint32 delta = uint32(uint256(ratePerBlock) * blocksDelta);
        _fundingIndex[poolId]    += delta;
        _lastFundingBlock[poolId] = currBlock;

        emit FundingAccrued(poolId, int32(ratePerBlock), _fundingIndex[poolId], uint48(block.timestamp));
    }

    // ── Internal: PnL ────────────────────────────────────────────────────────

    function _computePnL(Position storage pos)
        internal view returns (int128 pnl, uint128 fundingPaid)
    {
        uint32 currentPrice = _markPrice[pos.poolId];
        uint32 entryPrice   = pos.entryPrice;

        // Price PnL
        if (pos.side == Side.Long) {
            if (currentPrice > entryPrice) {
                pnl = int128(uint128(
                    (uint256(pos.sizeUsdc) * (currentPrice - entryPrice)) / PRICE_SCALE
                ));
            } else {
                pnl = -int128(uint128(
                    (uint256(pos.sizeUsdc) * (entryPrice - currentPrice)) / PRICE_SCALE
                ));
            }
        } else {
            if (currentPrice < entryPrice) {
                pnl = int128(uint128(
                    (uint256(pos.sizeUsdc) * (entryPrice - currentPrice)) / PRICE_SCALE
                ));
            } else {
                pnl = -int128(uint128(
                    (uint256(pos.sizeUsdc) * (currentPrice - entryPrice)) / PRICE_SCALE
                ));
            }
        }

        // Funding paid
        uint32 fundingDelta = _fundingIndex[pos.poolId] - pos.entryFundingIndex;
        fundingPaid = uint128(
            (uint256(pos.sizeUsdc) * fundingDelta) / FUNDING_SCALE
        );
    }

    // ── Internal: Liquidation check ───────────────────────────────────────────

    function _isLiquidatable(Position storage pos) internal view returns (bool) {
        uint32 currentPrice = _markPrice[pos.poolId];
        uint32 entryPrice   = pos.entryPrice;

        // Compute unrealised PnL
        int128 unrealisedPnl;
        if (pos.side == Side.Long) {
            if (currentPrice > entryPrice) {
                unrealisedPnl = int128(uint128(
                    (uint256(pos.sizeUsdc) * (currentPrice - entryPrice)) / PRICE_SCALE
                ));
            } else {
                unrealisedPnl = -int128(uint128(
                    (uint256(pos.sizeUsdc) * (entryPrice - currentPrice)) / PRICE_SCALE
                ));
            }
        } else {
            if (currentPrice < entryPrice) {
                unrealisedPnl = int128(uint128(
                    (uint256(pos.sizeUsdc) * (entryPrice - currentPrice)) / PRICE_SCALE
                ));
            } else {
                unrealisedPnl = -int128(uint128(
                    (uint256(pos.sizeUsdc) * (currentPrice - entryPrice)) / PRICE_SCALE
                ));
            }
        }

        // Funding accrued
        uint32 fundingDelta  = _fundingIndex[pos.poolId] - pos.entryFundingIndex;
        uint128 fundingOwed  = uint128(
            (uint256(pos.sizeUsdc) * fundingDelta) / FUNDING_SCALE
        );

        // Effective collateral
        int128 effectiveCollateral = int128(pos.collateralUsdc) + unrealisedPnl - int128(fundingOwed);
        if (effectiveCollateral <= 0) return true;

        // Maintenance margin check
        uint128 maintMargin = uint128(
            (uint256(pos.sizeUsdc) * pos.maintenanceMarginBps) / 10_000
        );

        return uint128(effectiveCollateral) < maintMargin;
    }
}
