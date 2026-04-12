// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/interfaces/IShared.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {PublisherStake} from "../src/PublisherStake.sol";
import {DeviationAdjudicator} from "../src/DeviationAdjudicator.sol";
import {PerpRiskParams} from "../src/PerpRiskParams.sol";

// ── Mock shMON token ──────────────────────────────────────────────────────────

contract MockShMON {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalBurned;

    function exchangeRate() external pure returns (uint256) { return 1.05e18; }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        balanceOf[from]             -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to]               += amount;
        return true;
    }

    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        totalBurned           += amount;
    }
}

// ── Base test setup ───────────────────────────────────────────────────────────

contract OracleStackTest is Test {

    MockShMON            shMon;
    PublisherStake       publisherStake;
    ScoreRegistry        scoreRegistry;
    DeviationAdjudicator adjudicator;
    PerpRiskParams       perpRiskParams;

    address deployer   = address(0x1);
    address publisher  = address(0x2);
    address publisher2 = address(0x3);
    address watchdog   = address(0x4);
    address perpDex    = address(0x5);
    address claimant   = address(0x6);
    address badActor   = address(0x7);

    uint128 constant MIN_STAKE_MON = 1000e18;
    uint128 constant STAKE_AMOUNT  = 1100e18;
    uint128 constant CLAIM_BOND    = 100e18;

    bytes32 constant POOL_ID = keccak256(abi.encodePacked(uint256(5000), "aave-v3", "USDT"));

    function setUp() public {
        vm.startPrank(deployer);

        shMon          = new MockShMON();
        publisherStake = new PublisherStake(address(shMon), address(0), MIN_STAKE_MON);
        scoreRegistry  = new ScoreRegistry(address(publisherStake));
        adjudicator    = new DeviationAdjudicator(address(publisherStake), address(scoreRegistry), address(shMon));
        perpRiskParams = new PerpRiskParams(address(scoreRegistry), perpDex);
        publisherStake.setAdjudicator(address(adjudicator));

        vm.stopPrank();

        shMon.mint(publisher,  STAKE_AMOUNT * 2);
        shMon.mint(publisher2, STAKE_AMOUNT * 2);
        shMon.mint(claimant,   CLAIM_BOND   * 2);
    }

    function _registerPublisher(address pub) internal {
        vm.startPrank(pub);
        shMon.approve(address(publisherStake), STAKE_AMOUNT);
        publisherStake.register(STAKE_AMOUNT);
        vm.stopPrank();
    }

    function _buildScore(
        bytes32 poolId, uint32 baseApy, uint32 rewardApy,
        uint128 tvlUsd, uint8 riskScore, uint8 confidence
    ) internal pure returns (PoolScore memory) {
        return PoolScore({
            poolId:           poolId,
            protocolName:     "Aave V3",
            symbol:           "USDT",
            category:         Category.Lending,
            baseApy:          baseApy,
            rewardApy:        rewardApy,
            netApy:           baseApy + rewardApy > 10 ? baseApy + rewardApy - 10 : 0,
            apyVolatility30d: 50,
            tvlUsd:           tvlUsd,
            liquidityDepth:   100,
            utilisationRate:  6000,
            riskScore:        riskScore,
            ilRisk:           0,
            auditScore:       90,
            protocolAgeDays:  730,
            confidence:       confidence,
            publisher:        address(0),
            timestamp:        0,
            updateCount:      0
        });
    }
}

// ── PublisherStake Tests ──────────────────────────────────────────────────────

contract PublisherStakeTest is OracleStackTest {

    function test_RegisterPublisher() public {
        _registerPublisher(publisher);
        assertTrue(publisherStake.isAuthorised(publisher));
    }

    function test_RegisterRequiresSufficientStake() public {
        uint128 tooLittle = 500e18;
        vm.startPrank(publisher);
        shMon.approve(address(publisherStake), tooLittle);
        vm.expectRevert();
        publisherStake.register(tooLittle);
        vm.stopPrank();
    }

    function test_CannotRegisterTwice() public {
        _registerPublisher(publisher);
        vm.startPrank(publisher);
        shMon.approve(address(publisherStake), STAKE_AMOUNT);
        vm.expectRevert();
        publisherStake.register(STAKE_AMOUNT);
        vm.stopPrank();
    }

    function test_TopUp() public {
        _registerPublisher(publisher);
        uint128 extra = 100e18;
        vm.startPrank(publisher);
        shMon.approve(address(publisherStake), extra);
        publisherStake.topUp(extra);
        vm.stopPrank();
        assertEq(publisherStake.getPublisher(publisher).shMonStaked, STAKE_AMOUNT + extra);
    }

    function test_UnbondingRemovesAuthorisation() public {
        _registerPublisher(publisher);
        vm.prank(publisher);
        publisherStake.startUnbonding();
        assertFalse(publisherStake.isAuthorised(publisher));
    }

    function test_CannotWithdrawBeforeUnbondingPeriod() public {
        _registerPublisher(publisher);
        vm.prank(publisher);
        publisherStake.startUnbonding();
        vm.prank(publisher);
        vm.expectRevert();
        publisherStake.withdraw();
    }

    function test_WithdrawAfterUnbondingPeriod() public {
        _registerPublisher(publisher);
        uint256 balanceBefore = shMon.balanceOf(publisher);
        vm.prank(publisher);
        publisherStake.startUnbonding();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(publisher);
        publisherStake.withdraw();
        assertEq(shMon.balanceOf(publisher), balanceBefore + STAKE_AMOUNT);
        assertFalse(publisherStake.isAuthorised(publisher));
    }

    function test_SlashReducesStake() public {
        _registerPublisher(publisher);
        uint128 stakeBefore = publisherStake.getPublisher(publisher).shMonStaked;
        vm.prank(address(adjudicator));
        publisherStake.slash(publisher, 200e18, watchdog);
        assertLt(publisherStake.getPublisher(publisher).shMonStaked, stakeBefore);
    }

    function test_OnlyAdjudicatorCanSlash() public {
        _registerPublisher(publisher);
        vm.prank(badActor);
        vm.expectRevert();
        publisherStake.slash(publisher, 200e18, watchdog);
    }

    function test_ThreeSlashesBanPublisher() public {
        _registerPublisher(publisher);
        vm.startPrank(address(adjudicator));
        publisherStake.slash(publisher, 100e18, watchdog);
        publisherStake.slash(publisher, 100e18, watchdog);
        publisherStake.slash(publisher, 100e18, watchdog);
        vm.stopPrank();
        assertEq(uint8(publisherStake.getPublisher(publisher).status), uint8(PublisherStatus.Banned));
        assertFalse(publisherStake.isAuthorised(publisher));
    }

    function test_BannedPublisherCannotReregister() public {
        _registerPublisher(publisher);
        vm.startPrank(address(adjudicator));
        publisherStake.slash(publisher, 100e18, watchdog);
        publisherStake.slash(publisher, 100e18, watchdog);
        publisherStake.slash(publisher, 100e18, watchdog);
        vm.stopPrank();
        shMon.mint(publisher, STAKE_AMOUNT);
        vm.startPrank(publisher);
        shMon.approve(address(publisherStake), STAKE_AMOUNT);
        vm.expectRevert();
        publisherStake.register(STAKE_AMOUNT);
        vm.stopPrank();
    }
}

// ── ScoreRegistry Tests ───────────────────────────────────────────────────────

contract ScoreRegistryTest is OracleStackTest {

    function test_AuthorisedPublisherCanPublish() public {
        _registerPublisher(publisher);
        PoolScore memory score = _buildScore(POOL_ID, 200, 50, 10_000_000e6, 80, 90);
        vm.prank(publisher);
        scoreRegistry.publishScore(score);
        assertTrue(scoreRegistry.isRegistered(POOL_ID));
        assertEq(scoreRegistry.poolCount(), 1);
    }

    function test_UnauthorisedCannotPublish() public {
        PoolScore memory score = _buildScore(POOL_ID, 200, 50, 10_000_000e6, 80, 90);
        vm.prank(badActor);
        vm.expectRevert();
        scoreRegistry.publishScore(score);
    }

    function test_ScoreStoredCorrectly() public {
        _registerPublisher(publisher);
        PoolScore memory score = _buildScore(POOL_ID, 300, 100, 5_000_000e6, 75, 85);
        vm.prank(publisher);
        scoreRegistry.publishScore(score);
        PoolScore memory stored = scoreRegistry.getLatestScore(POOL_ID);
        assertEq(stored.baseApy,    300);
        assertEq(stored.rewardApy,  100);
        assertEq(stored.riskScore,  75);
        assertEq(stored.confidence, 85);
        assertEq(stored.publisher,  publisher);
    }

    function test_RateLimitPreventsSpam() public {
        _registerPublisher(publisher);
        PoolScore memory score = _buildScore(POOL_ID, 200, 50, 10_000_000e6, 80, 90);
        vm.startPrank(publisher);
        scoreRegistry.publishScore(score);
        vm.expectRevert();
        scoreRegistry.publishScore(score);
        vm.stopPrank();
    }

    function test_HistoryAccumulates() public {
        _registerPublisher(publisher);
        PoolScore memory score = _buildScore(POOL_ID, 200, 50, 10_000_000e6, 80, 90);
        vm.warp(1000);
        vm.startPrank(publisher);
        scoreRegistry.publishScore(score);
        vm.stopPrank();
        vm.warp(2000);
        vm.startPrank(publisher);
        score.baseApy = 210;
        scoreRegistry.publishScore(score);
        vm.stopPrank();
        vm.warp(3000);
        vm.startPrank(publisher);
        score.baseApy = 220;
        scoreRegistry.publishScore(score);
        vm.stopPrank();
        PoolScore[] memory history = scoreRegistry.getScoreHistory(POOL_ID, 10);
        assertEq(history.length,      3);
        assertEq(history[2].baseApy, 220);
    }

    function test_DerivePoolId() public view {
        bytes32 id = scoreRegistry.derivePoolId(5000, "aave-v3", "USDT");
        assertEq(id, POOL_ID);
    }

    function test_InvalidRiskScoreReverts() public {
        _registerPublisher(publisher);
        PoolScore memory score = _buildScore(POOL_ID, 200, 50, 10_000_000e6, 80, 90);
        score.riskScore = 101;
        vm.prank(publisher);
        vm.expectRevert();
        scoreRegistry.publishScore(score);
    }

    function test_GetTotalApy() public {
        _registerPublisher(publisher);
        PoolScore memory score = _buildScore(POOL_ID, 300, 150, 10_000_000e6, 80, 90);
        vm.prank(publisher);
        scoreRegistry.publishScore(score);
        (uint32 totalApy,) = scoreRegistry.getTotalApy(POOL_ID);
        assertEq(totalApy, 450);
    }

    function test_UnregisteredPoolReturnsFalse() public view {
        assertFalse(scoreRegistry.isRegistered(POOL_ID));
    }
}

// ── PerpRiskParams Tests ──────────────────────────────────────────────────────

contract PerpRiskParamsTest is OracleStackTest {

    function _publishAndRegister(uint8 riskScore, uint8 confidence, uint128 tvlUsd, uint32 apyVol) internal {
        _registerPublisher(publisher);
        PoolScore memory score = _buildScore(POOL_ID, 300, 100, tvlUsd, riskScore, confidence);
        score.apyVolatility30d = apyVol;
        vm.prank(publisher);
        scoreRegistry.publishScore(score);
        vm.prank(perpDex);
        perpRiskParams.registerPool(POOL_ID, 0);
    }

    function test_ParamsDerivedFromScore() public {
        _publishAndRegister(80, 90, 10_000_000e6, 50);
        vm.prank(perpDex);
        RiskParams memory params = perpRiskParams.getParams(POOL_ID);
        assertFalse(params.tradingHalted);
        assertGt(params.maxOI, 0);
        assertGt(params.maxLeverage, 0);
        assertGt(params.initialMarginBps, 0);
        assertEq(params.confidenceUsed, 90);
    }

    function test_CircuitBreakerOnStaleScore() public {
        _publishAndRegister(80, 90, 10_000_000e6, 50);
        vm.warp(block.timestamp + 3 hours);
        // Score is now stale (3h > MAX_SCORE_AGE of 2h) — must revert with StaleScore
        vm.prank(perpDex);
        vm.expectRevert(abi.encodeWithSignature(
            "StaleScore(bytes32,uint48,uint32)", POOL_ID, uint48(10800), uint32(7200)
        ));
        perpRiskParams.getParams(POOL_ID);
    }

    function test_CircuitBreakerOnLowConfidence() public {
        _publishAndRegister(80, 30, 10_000_000e6, 50);
        // Confidence 30 is below MIN_CONFIDENCE (50) — getParams must revert
        vm.prank(perpDex);
        vm.expectRevert(abi.encodeWithSignature(
            "ConfidenceTooLow(bytes32,uint8,uint8)", POOL_ID, uint8(30), uint8(50)
        ));
        perpRiskParams.getParams(POOL_ID);
    }

    function test_CircuitBreakerOnCriticalRiskScore() public {
        _publishAndRegister(15, 90, 10_000_000e6, 50);
        // Risk score 15 is below MIN_RISK_SCORE_TO_TRADE (20) — must revert
        vm.prank(perpDex);
        vm.expectRevert(abi.encodeWithSignature(
            "TradingHalted(bytes32,string)", POOL_ID, "Risk score critical"
        ));
        perpRiskParams.getParams(POOL_ID);
    }

    function test_ClearCircuitBreaker() public {
        _publishAndRegister(80, 90, 10_000_000e6, 50);
        vm.warp(block.timestamp + 3 hours);
        vm.prank(perpDex);
        vm.expectRevert();
        perpRiskParams.getParams(POOL_ID);
        vm.prank(perpDex);
        perpRiskParams.clearCircuitBreaker(POOL_ID);
        vm.warp(block.timestamp + 120);
        PoolScore memory fresh = _buildScore(POOL_ID, 300, 100, 10_000_000e6, 80, 90);
        vm.prank(publisher);
        scoreRegistry.publishScore(fresh);
        vm.prank(perpDex);
        RiskParams memory params = perpRiskParams.getParams(POOL_ID);
        assertFalse(params.tradingHalted);
    }

    function test_OnlyPerpDexCanRegisterPool() public {
        _registerPublisher(publisher);
        vm.prank(badActor);
        vm.expectRevert();
        perpRiskParams.registerPool(POOL_ID, 0);
    }

    function test_MaintenanceMarginLessThanInitial() public {
        _publishAndRegister(80, 90, 10_000_000e6, 50);
        vm.prank(perpDex);
        RiskParams memory params = perpRiskParams.getParams(POOL_ID);
        assertLt(params.maintenanceMarginBps, params.initialMarginBps);
    }

    function test_CachedParamsAvailable() public {
        _publishAndRegister(80, 90, 10_000_000e6, 50);
        vm.prank(perpDex);
        perpRiskParams.getParams(POOL_ID);
        RiskParams memory cached = perpRiskParams.getCachedParams(POOL_ID);
        assertGt(cached.maxOI, 0);
    }
}

// ── Integration Tests ─────────────────────────────────────────────────────────

contract IntegrationTest is OracleStackTest {

    function test_FullStackFlow() public {
        _registerPublisher(publisher);
        assertTrue(publisherStake.isAuthorised(publisher));

        PoolScore memory score = _buildScore(POOL_ID, 400, 100, 50_000_000e6, 85, 95);
        vm.prank(publisher);
        scoreRegistry.publishScore(score);
        assertTrue(scoreRegistry.isRegistered(POOL_ID));

        vm.prank(perpDex);
        perpRiskParams.registerPool(POOL_ID, 0);

        vm.prank(perpDex);
        RiskParams memory params = perpRiskParams.getParams(POOL_ID);
        assertFalse(params.tradingHalted);
        assertGt(params.maxOI, 0);
        assertGt(params.maxLeverage, 1);

        vm.prank(publisher);
        publisherStake.startUnbonding();
        assertFalse(publisherStake.isAuthorised(publisher));

        vm.warp(block.timestamp + 120);
        vm.prank(publisher);
        vm.expectRevert();
        scoreRegistry.publishScore(score);
    }

    function test_MultiplePublishersIndependent() public {
        _registerPublisher(publisher);
        _registerPublisher(publisher2);

        bytes32 pool2 = keccak256(abi.encodePacked(uint256(5000), "compound-v3", "USDC"));
        PoolScore memory score1 = _buildScore(POOL_ID, 300, 100, 10_000_000e6, 80, 90);
        PoolScore memory score2 = _buildScore(pool2,   200,  50,  5_000_000e6, 70, 85);

        vm.prank(publisher);
        scoreRegistry.publishScore(score1);
        vm.prank(publisher2);
        scoreRegistry.publishScore(score2);

        assertEq(scoreRegistry.poolCount(), 2);
        assertEq(scoreRegistry.getLatestScore(POOL_ID).publisher, publisher);
        assertEq(scoreRegistry.getLatestScore(pool2).publisher,   publisher2);
    }

    function test_SlashedPublisherCannotPublish() public {
        _registerPublisher(publisher);
        vm.prank(address(adjudicator));
        publisherStake.slash(publisher, 900e18, watchdog);
        assertFalse(publisherStake.isAuthorised(publisher));
        PoolScore memory score = _buildScore(POOL_ID, 300, 100, 10_000_000e6, 80, 90);
        vm.prank(publisher);
        vm.expectRevert();
        scoreRegistry.publishScore(score);
    }
}
