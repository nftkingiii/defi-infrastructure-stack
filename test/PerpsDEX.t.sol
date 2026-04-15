// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/interfaces/IShared.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {PublisherStake} from "../src/PublisherStake.sol";
import {DeviationAdjudicator} from "../src/DeviationAdjudicator.sol";
import {PerpRiskParams} from "../src/PerpRiskParams.sol";
import {PerpsDEX} from "../src/PerpsDEX.sol";

contract MockShMON {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function exchangeRate() external pure returns (uint256) { return 1.05e18; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allow");
        balanceOf[from] -= amount; allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount; return true;
    }
    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
    }
}

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allow");
        balanceOf[from] -= amount; allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount; return true;
    }
}

contract PerpsDEXTest is Test {

    MockShMON            shMon;
    MockUSDC             usdc;
    PublisherStake       publisherStake;
    ScoreRegistry        scoreRegistry;
    DeviationAdjudicator adjudicator;
    PerpRiskParams       perpRiskParams;
    PerpsDEX             perpsDex;

    address owner      = address(0x1);
    address publisher  = address(0x2);
    address trader     = address(0x3);
    address trader2    = address(0x4);
    address liquidator = address(0x5);

    uint128 constant STAKE_AMOUNT  = 1100e18;
    uint128 constant MIN_STAKE_MON = 1000e18;
    uint128 constant COLLATERAL    = 1000e6;
    uint32  constant INITIAL_PRICE = 10_000;

    bytes32 constant POOL_ID = keccak256(abi.encodePacked(uint256(5000), "aave-v3", "USDT"));

    function setUp() public {
        vm.startPrank(owner);
        shMon          = new MockShMON();
        usdc           = new MockUSDC();
        publisherStake = new PublisherStake(address(shMon), address(0), MIN_STAKE_MON);
        scoreRegistry  = new ScoreRegistry(address(publisherStake));
        adjudicator    = new DeviationAdjudicator(address(publisherStake), address(scoreRegistry), address(shMon));
        perpRiskParams = new PerpRiskParams(address(scoreRegistry), owner);
        perpsDex       = new PerpsDEX(address(perpRiskParams), address(usdc));
        publisherStake.setAdjudicator(address(adjudicator));
        vm.stopPrank();

        shMon.mint(publisher, STAKE_AMOUNT * 2);
        vm.startPrank(publisher);
        shMon.approve(address(publisherStake), STAKE_AMOUNT);
        publisherStake.register(STAKE_AMOUNT);
        vm.stopPrank();

        PoolScore memory score = PoolScore({
            poolId: POOL_ID, protocolName: "Aave V3", symbol: "USDT",
            category: Category.Lending,
            baseApy: 300, rewardApy: 100, netApy: 390,
            apyVolatility30d: 50, tvlUsd: 10_000_000e6,
            liquidityDepth: 100, utilisationRate: 6000,
            riskScore: 80, ilRisk: 0, auditScore: 90,
            protocolAgeDays: 730, confidence: 90,
            publisher: address(0), timestamp: 0, updateCount: 0
        });
        vm.prank(publisher);
        scoreRegistry.publishScore(score);

        vm.prank(owner);
        perpRiskParams.registerPool(POOL_ID, 0);

        vm.prank(owner);
        perpsDex.addPool(POOL_ID, INITIAL_PRICE);

        // Fund traders and DEX contract
        usdc.mint(trader,            10_000e6);
        usdc.mint(trader2,           10_000e6);
        usdc.mint(liquidator,        10_000e6);
        usdc.mint(address(perpsDex), 10_000_000e6);

        vm.prank(trader);
        usdc.approve(address(perpsDex), type(uint256).max);
        vm.prank(trader2);
        usdc.approve(address(perpsDex), type(uint256).max);
        vm.prank(liquidator);
        usdc.approve(address(perpsDex), type(uint256).max);
    }
}

contract PerpsDEXPositionTest is PerpsDEXTest {

    function test_OpenLongPosition() public {
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        Position memory pos = perpsDex.getPosition(posId);
        assertEq(pos.trader,         trader);
        assertEq(uint8(pos.side),    uint8(Side.Long));
        assertEq(pos.collateralUsdc, COLLATERAL);
        assertEq(pos.sizeUsdc,       COLLATERAL * 2);
        assertEq(pos.leverage,       2);
        assertTrue(pos.isOpen);
    }

    function test_OpenShortPosition() public {
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Short, COLLATERAL, 3);
        Position memory pos = perpsDex.getPosition(posId);
        assertEq(uint8(pos.side), uint8(Side.Short));
        assertEq(pos.sizeUsdc,    COLLATERAL * 3);
        assertTrue(pos.isOpen);
    }

    function test_OpenPositionUpdatesOI() public {
        uint128 oiBefore = perpsDex.getOpenInterest(POOL_ID);
        vm.prank(trader);
        perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        assertEq(perpsDex.getOpenInterest(POOL_ID), oiBefore + COLLATERAL * 2);
    }

    function test_ExceedsMaxLeverageReverts() public {
        vm.prank(trader);
        vm.expectRevert();
        perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 100);
    }

    function test_InsufficientCollateralReverts() public {
        // initialMarginBps ~505 bps
        // At leverage 20: size = col*20, requiredMargin = col*20*505/10000 = col*1.01 > col
        // So leverage 20 should revert due to insufficient collateral
        vm.prank(trader);
        vm.expectRevert();
        perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 20);
    }

    function test_CloseLongPositionProfit() public {
        uint256 balStart = usdc.balanceOf(trader);
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        // Price moves up 10%
        vm.prank(owner);
        perpsDex.updatePrice(POOL_ID, 11_000);
        vm.prank(trader);
        perpsDex.closePosition(posId);
        uint256 balEnd = usdc.balanceOf(trader);
        assertGt(balEnd, balStart);
    }

    function test_CloseLongPositionLoss() public {
        uint256 balStart = usdc.balanceOf(trader);
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        // Price drops 5%
        vm.prank(owner);
        perpsDex.updatePrice(POOL_ID, 9_500);
        vm.prank(trader);
        perpsDex.closePosition(posId);
        uint256 balEnd = usdc.balanceOf(trader);
        assertLt(balEnd, balStart);
    }

    function test_CloseShortPositionProfit() public {
        uint256 balStart = usdc.balanceOf(trader);
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Short, COLLATERAL, 2);
        // Price drops 10%
        vm.prank(owner);
        perpsDex.updatePrice(POOL_ID, 9_000);
        vm.prank(trader);
        perpsDex.closePosition(posId);
        uint256 balEnd = usdc.balanceOf(trader);
        assertGt(balEnd, balStart);
    }

    function test_OnlyOwnerCanClosePosition() public {
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        vm.prank(trader2);
        vm.expectRevert();
        perpsDex.closePosition(posId);
    }

    function test_CannotCloseAlreadyClosedPosition() public {
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        vm.prank(trader);
        perpsDex.closePosition(posId);
        vm.prank(trader);
        vm.expectRevert();
        perpsDex.closePosition(posId);
    }
}

contract PerpsDEXLiquidationTest is PerpsDEXTest {

    function test_LiquidationOnLargeAdversePriceMove() public {
        // Open 10x long — high leverage position
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 10);

        // Price crashes 15%
        vm.prank(owner);
        perpsDex.updatePrice(POOL_ID, 8_500);

        assertTrue(perpsDex.isLiquidatable(posId));

        uint256 liqBalBefore = usdc.balanceOf(liquidator);
        vm.prank(liquidator);
        perpsDex.liquidate(posId);
        uint256 liqBalAfter = usdc.balanceOf(liquidator);

        assertGt(liqBalAfter, liqBalBefore);
        assertFalse(perpsDex.getPosition(posId).isOpen);
    }

    function test_CannotLiquidateHealthyPosition() public {
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        assertFalse(perpsDex.isLiquidatable(posId));
        vm.expectRevert();
        perpsDex.liquidate(posId);
    }

    function test_LiquidationTrackedByScoreBucket() public {
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 10);
        vm.prank(owner);
        perpsDex.updatePrice(POOL_ID, 8_500);
        vm.prank(liquidator);
        perpsDex.liquidate(posId);
        (uint256 liquidations,,) = perpsDex.getLiquidationRate(9);
        assertEq(liquidations, 1);
    }

    function test_LiquidationRateComputed() public {
        vm.prank(trader);
        uint256 pos1 = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 10);
        vm.prank(trader2);
        perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);
        vm.prank(owner);
        perpsDex.updatePrice(POOL_ID, 8_500);
        vm.prank(liquidator);
        perpsDex.liquidate(pos1);
        (uint256 liq, uint256 pos, uint256 rateBps) = perpsDex.getLiquidationRate(9);
        assertEq(liq,     1);
        assertEq(pos,     2);
        assertEq(rateBps, 5_000);
    }
}

contract PerpsDEXFundingTest is PerpsDEXTest {

    function test_FundingIndexIsTracked() public {
        // Open position to initialise funding tracking
        vm.prank(trader);
        uint256 posId = perpsDex.openPosition(POOL_ID, Side.Long, COLLATERAL, 2);

        uint32 fundingAtOpen = perpsDex.getFundingIndex(POOL_ID);

        // Advance blocks and trigger funding accrual via price update
        vm.roll(block.number + 172_800);
        vm.prank(owner);
        perpsDex.updatePrice(POOL_ID, INITIAL_PRICE);

        uint32 fundingAfter = perpsDex.getFundingIndex(POOL_ID);
        // Funding index is monotonically non-decreasing
        assertGe(fundingAfter, fundingAtOpen);

        // Position should close cleanly at same price (no PnL, minimal/zero funding)
        uint256 balBefore = usdc.balanceOf(trader);
        vm.prank(trader);
        perpsDex.closePosition(posId);
        uint256 balAfter = usdc.balanceOf(trader);
        // Gets back at least some of collateral
        assertGt(balAfter, balBefore);
    }
}

contract PerpsDEXOITest is PerpsDEXTest {

    function test_OICapEnforced() public {
        // maxOI for pool with tvlUsd=10_000_000e6, riskScore=80:
        // = 10_000_000e6 * 3000 * 80 / (10000*100) = 2_400_000e6
        // minus liquidity penalty (100 bps) = ~2_376_000e6
        // Open positions > cap should revert

        uint128 bigCol = 1_300_000e6;
        usdc.mint(trader,  bigCol * 3);
        usdc.mint(trader2, bigCol * 3);
        usdc.mint(address(perpsDex), bigCol * 10);

        vm.prank(trader);
        usdc.approve(address(perpsDex), type(uint256).max);
        vm.prank(trader2);
        usdc.approve(address(perpsDex), type(uint256).max);

        // First: 1.3M * 2x = 2.6M OI — exceeds 2.376M cap already, should revert
        vm.prank(trader);
        vm.expectRevert();
        perpsDex.openPosition(POOL_ID, Side.Long, bigCol, 2);
    }
}
