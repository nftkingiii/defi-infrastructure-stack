// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IShared.sol";

event ClaimSubmitted(uint256 indexed claimId, bytes32 indexed poolId, address indexed publisher, address claimant, uint8 reason, uint48 settlementEndsAt);
event ClaimExecuted(uint256 indexed claimId, address indexed publisher, address indexed watchdog, uint8 reason, uint128 slashAmount);
event ClaimRejected(uint256 indexed claimId, address indexed claimant, uint128 bondBurned);
event ClaimExpired(uint256 indexed claimId, uint128 bondReturned);
event EvidenceRootPosted(bytes32 indexed poolId, address indexed publisher, uint256 indexed windowStart, bytes32 root);

error ClaimNotFound(uint256 claimId);
error ClaimNotPending(uint256 claimId, ClaimStatus status);
error SettlementWindowNotPassed(uint48 endsAt, uint48 current);
error InvalidProof(bytes32 leaf, bytes32 root);
error DuplicateClaim(bytes32 poolId, address publisher);

contract DeviationAdjudicator {

    uint32  public constant DEFAULT_APY_THRESHOLD_BPS      = 500;
    uint32  public constant DEFAULT_LOSS_TVL_DROP_BPS      = 2_000;
    uint8   public constant SAFE_RISK_THRESHOLD            = 70;
    uint8   public constant MIN_CONFIDENCE_FRAUD_THRESHOLD = 80;
    uint48  public constant DEFAULT_SETTLEMENT_WINDOW      = 30 days;
    uint48  public constant EXECUTION_WINDOW               = 7 days;
    uint128 public constant DEFAULT_SLASH_AMOUNT_MON       = 500e18;
    uint128 public constant CLAIMANT_BOND_MON              = 50e18;

    IPublisherStake public immutable publisherStake;
    IScoreRegistry  public immutable scoreRegistry;
    address         public immutable shMon;

    uint32  public apyThresholdBps;
    uint32  public lossTvlDropBps;
    uint48  public settlementWindow;
    uint128 public slashAmountMon;

    uint256                     public claimCount;
    mapping(uint256 => Claim)   private _claims;
    mapping(bytes32 => uint256) private _activeClaim;
    mapping(bytes32 => bool)    private _hasActiveClaim;
    mapping(address => mapping(bytes32 => mapping(uint256 => bytes32))) private _evidenceRoots;

    constructor(address _publisherStake, address _scoreRegistry, address _shMon) {
        if (_publisherStake == address(0) || _scoreRegistry == address(0) || _shMon == address(0)) {
            revert ZeroAddress();
        }
        publisherStake   = IPublisherStake(_publisherStake);
        scoreRegistry    = IScoreRegistry(_scoreRegistry);
        shMon            = _shMon;
        apyThresholdBps  = DEFAULT_APY_THRESHOLD_BPS;
        lossTvlDropBps   = DEFAULT_LOSS_TVL_DROP_BPS;
        settlementWindow = DEFAULT_SETTLEMENT_WINDOW;
        slashAmountMon   = DEFAULT_SLASH_AMOUNT_MON;
    }

    function postEvidenceRoot(bytes32 poolId, uint256 windowStart, bytes32 root) external {
        _evidenceRoots[msg.sender][poolId][windowStart] = root;
        emit EvidenceRootPosted(poolId, msg.sender, windowStart, root);
    }

    function getEvidenceRoot(address poster, bytes32 poolId, uint256 windowStart) external view returns (bytes32) {
        return _evidenceRoots[poster][poolId][windowStart];
    }

    function submitClaim(bytes32 poolId, address publisher, SlashReason reason, uint128 bond)
        external returns (uint256 claimId)
    {
        bytes32 claimKey = keccak256(abi.encodePacked(publisher, poolId));
        if (_hasActiveClaim[claimKey]) revert DuplicateClaim(poolId, publisher);

        (bool ok,) = shMon.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), bond)
        );
        require(ok, "Bond transfer failed");

        PoolScore memory score = scoreRegistry.getLatestScore(poolId);
        uint48 now48     = uint48(block.timestamp);
        uint48 settlesAt = now48 + settlementWindow;

        claimId = ++claimCount;
        _claims[claimId] = Claim({
            poolId:              poolId,
            publisher:           publisher,
            claimant:            msg.sender,
            submittedAt:         now48,
            settlementEndsAt:    settlesAt,
            claimantBond:        bond,
            publishedApy:        score.baseApy + score.rewardApy,
            publishedRiskScore:  score.riskScore,
            publishedConfidence: score.confidence,
            publishedTvl:        score.tvlUsd,
            status:              ClaimStatus.Pending,
            reason:              reason
        });

        _activeClaim[claimKey]    = claimId;
        _hasActiveClaim[claimKey] = true;

        emit ClaimSubmitted(claimId, poolId, publisher, msg.sender, uint8(reason), settlesAt);
    }

    function executeClaim(
        uint256 claimId, address evidencePoster, uint256 windowStart,
        uint32 realisedApy, uint128 realisedTvl, uint32 updateCount,
        bytes32[] calldata proof
    ) external {
        Claim storage claim = _claims[claimId];
        if (claim.submittedAt == 0)              revert ClaimNotFound(claimId);
        if (claim.status != ClaimStatus.Pending) revert ClaimNotPending(claimId, claim.status);

        uint48 now48 = uint48(block.timestamp);
        if (now48 < claim.settlementEndsAt) revert SettlementWindowNotPassed(claim.settlementEndsAt, now48);

        if (now48 > claim.settlementEndsAt + EXECUTION_WINDOW) {
            claim.status = ClaimStatus.Expired;
            _clearActiveClaim(claim.publisher, claim.poolId);
            _transferShMon(claim.claimant, claim.claimantBond);
            emit ClaimExpired(claimId, claim.claimantBond);
            return;
        }

        bytes32 leaf = _buildLeaf(claim.settlementEndsAt, realisedApy, realisedTvl, updateCount);
        bytes32 root = _evidenceRoots[evidencePoster][claim.poolId][windowStart];
        if (!_verifyProof(proof, root, leaf)) revert InvalidProof(leaf, root);

        bool slashTriggered = _evaluateDeviation(claim, realisedApy, realisedTvl, updateCount);
        _clearActiveClaim(claim.publisher, claim.poolId);

        if (slashTriggered) {
            claim.status = ClaimStatus.Executed;
            publisherStake.slash(claim.publisher, slashAmountMon, msg.sender);
            _transferShMon(claim.claimant, claim.claimantBond);
            emit ClaimExecuted(claimId, claim.publisher, msg.sender, uint8(claim.reason), slashAmountMon);
        } else {
            claim.status = ClaimStatus.Rejected;
            _burnShMon(claim.claimantBond);
            emit ClaimRejected(claimId, claim.claimant, claim.claimantBond);
        }
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        if (_claims[claimId].submittedAt == 0) revert ClaimNotFound(claimId);
        return _claims[claimId];
    }

    function hasActiveClaim(address publisher, bytes32 poolId) external view returns (bool, uint256) {
        bytes32 key = keccak256(abi.encodePacked(publisher, poolId));
        return (_hasActiveClaim[key], _activeClaim[key]);
    }

    function _evaluateDeviation(Claim storage claim, uint32 realisedApy, uint128 realisedTvl, uint32 updateCount)
        internal view returns (bool)
    {
        if (claim.reason == SlashReason.ApyDeviation) {
            uint32 delta = claim.publishedApy > realisedApy
                ? claim.publishedApy - realisedApy
                : realisedApy - claim.publishedApy;
            return delta > apyThresholdBps;
        }
        if (claim.reason == SlashReason.RiskScoreFlip) {
            if (claim.publishedRiskScore < SAFE_RISK_THRESHOLD) return false;
            if (claim.publishedTvl == 0 || realisedTvl >= claim.publishedTvl) return false;
            uint256 dropBps = ((uint256(claim.publishedTvl) - realisedTvl) * 10_000) / uint256(claim.publishedTvl);
            return dropBps > lossTvlDropBps;
        }
        if (claim.reason == SlashReason.ConfidenceFraud) {
            if (claim.publishedConfidence < MIN_CONFIDENCE_FRAUD_THRESHOLD) return false;
            PoolScore memory latest = scoreRegistry.getLatestScore(claim.poolId);
            return updateCount == latest.updateCount;
        }
        return false;
    }

    function _buildLeaf(uint48 timestamp, uint32 realisedApy, uint128 tvlUsd, uint32 updateCount)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(timestamp, realisedApy, tvlUsd, updateCount));
    }

    function _verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf)
        internal pure returns (bool)
    {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == root;
    }

    function _clearActiveClaim(address publisher, bytes32 poolId) internal {
        bytes32 key = keccak256(abi.encodePacked(publisher, poolId));
        _hasActiveClaim[key] = false;
        _activeClaim[key]    = 0;
    }

    function _transferShMon(address to, uint128 amount) internal {
        (bool ok,) = shMon.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok, "shMON transfer failed");
    }

    function _burnShMon(uint128 amount) internal {
        (bool ok,) = shMon.call(abi.encodeWithSignature("burn(uint256)", amount));
        require(ok, "shMON burn failed");
    }
}
