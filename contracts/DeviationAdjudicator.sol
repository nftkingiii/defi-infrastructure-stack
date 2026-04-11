// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title DeviationAdjudicator
 * @notice Permissionless watchdog that verifies published scores against
 *         realised outcomes and triggers slashes on PublisherStake.
 *
 * Design:
 *  - Anyone can submit a deviation claim against a publisher for a pool.
 *  - Claims require a settlement window to pass (default 30 days) so
 *    realised APY can be computed from on-chain evidence.
 *  - Evidence is a merkle proof of historical price/liquidity snapshots
 *    committed to an Evidence Accumulator (off-chain indexer posts root).
 *  - If the deviation between published score and realised outcome exceeds
 *    the threshold, slash() is called on PublisherStake.
 *  - The caller who successfully executes a slash earns a bounty from
 *    the slashed stake, creating a natural watchdog incentive.
 *  - Claims that fail (deviation within threshold) penalise the claimant
 *    via a small bond to prevent griefing.
 *
 * Slash conditions (any one sufficient):
 *  1. APY deviation: |published_apy - realised_apy| > APY_DEVIATION_THRESHOLD_BPS
 *  2. Risk score flip: published riskScore >= SAFE_THRESHOLD but pool suffered
 *     a loss event (TVL drop > LOSS_EVENT_TVL_DROP_BPS within settlement window)
 *  3. Confidence fraud: publisher reported confidence >= MIN_CONFIDENCE but
 *     zero updates were made during the settlement window (stale data)
 *
 * Evidence format:
 *  Publishers and indexers post an EvidenceRoot (merkle root of snapshots)
 *  for each (publisher, poolId, settlementWindow). Claimants submit merkle
 *  proofs against this root to prove realised values on-chain cheaply.
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IPublisherStake {
    function slash(address publisher, uint128 slashMonAmount, address watchdog) external;
    function isAuthorised(address publisher) external view returns (bool);
}

interface IScoreRegistry {
    struct PoolScore {
        bytes32  poolId;
        string   protocolName;
        string   symbol;
        uint8    category;
        uint32   baseApy;
        uint32   rewardApy;
        uint32   netApy;
        uint32   apyVolatility30d;
        uint128  tvlUsd;
        uint32   liquidityDepth;
        uint32   utilisationRate;
        uint8    riskScore;
        uint8    ilRisk;
        uint8    auditScore;
        uint16   protocolAgeDays;
        uint8    confidence;
        address  publisher;
        uint48   timestamp;
        uint32   updateCount;
    }

    function getLatestScore(bytes32 poolId) external view returns (PoolScore memory);
    function getScoreHistory(bytes32 poolId, uint256 n) external view returns (PoolScore[] memory);
}

// ── Types ─────────────────────────────────────────────────────────────────────

enum ClaimStatus {
    Pending,    // 0 — submitted, awaiting settlement window
    Executed,   // 1 — slash executed
    Rejected,   // 2 — deviation within threshold, claimant bond burned
    Expired     // 3 — not executed within execution window, bond returned
}

enum SlashReason {
    ApyDeviation,     // 0 — published APY too far from realised
    RiskScoreFlip,    // 1 — pool suffered loss event despite safe score
    ConfidenceFraud   // 2 — high confidence but stale/no updates
}

struct Claim {
    bytes32      poolId;
    address      publisher;
    address      claimant;
    uint48       submittedAt;
    uint48       settlementEndsAt;
    uint128      claimantBond;       // shMON bond posted by claimant
    uint32       publishedApy;       // totalApy at time of claim (bps)
    uint8        publishedRiskScore;
    uint8        publishedConfidence;
    uint128      publishedTvl;
    ClaimStatus  status;
    SlashReason  reason;
}

struct EvidenceSnapshot {
    uint48  timestamp;
    uint32  realisedApy;    // bps
    uint128 tvlUsd;         // 1e6 scaled
    uint32  updateCount;    // registry update count at snapshot time
}

// ── Events ────────────────────────────────────────────────────────────────────

event ClaimSubmitted(
    uint256 indexed claimId,
    bytes32 indexed poolId,
    address indexed publisher,
    address claimant,
    SlashReason reason,
    uint48  settlementEndsAt
);

event ClaimExecuted(
    uint256 indexed claimId,
    address indexed publisher,
    address indexed watchdog,
    SlashReason reason,
    uint128 slashAmount
);

event ClaimRejected(
    uint256 indexed claimId,
    address indexed claimant,
    uint128 bondBurned
);

event ClaimExpired(uint256 indexed claimId, uint128 bondReturned);

event EvidenceRootPosted(
    bytes32 indexed poolId,
    address indexed publisher,
    uint256 indexed windowStart,
    bytes32 root
);

event ParametersUpdated(
    uint32 apyThreshold,
    uint32 tvlDropThreshold,
    uint48 settlementWindow,
    uint128 slashAmount
);

// ── Errors ────────────────────────────────────────────────────────────────────

error ClaimNotFound(uint256 claimId);
error ClaimNotPending(uint256 claimId, ClaimStatus status);
error SettlementWindowNotPassed(uint48 endsAt, uint48 current);
error ExecutionWindowExpired(uint256 claimId);
error InsufficientBond(uint128 provided, uint128 required);
error InvalidProof(bytes32 leaf, bytes32 root);
error PoolNotFound(bytes32 poolId);
error NothingToSlash(address publisher);
error DuplicateClaim(bytes32 poolId, address publisher);
error ZeroAddress();

// ── Contract ──────────────────────────────────────────────────────────────────

contract DeviationAdjudicator {

    // ── Constants ─────────────────────────────────────────────────────────────

    // APY deviation threshold: 500 bps = 5 percentage points
    uint32  public constant DEFAULT_APY_THRESHOLD_BPS     = 500;
    // TVL drop that constitutes a loss event: 2000 bps = 20%
    uint32  public constant DEFAULT_LOSS_TVL_DROP_BPS      = 2_000;
    // Risk score above which a loss event triggers a slash
    uint8   public constant SAFE_RISK_THRESHOLD            = 70;
    // Min confidence level above which stale data is fraudulent
    uint8   public constant MIN_CONFIDENCE_FRAUD_THRESHOLD = 80;
    // Settlement window: 30 days
    uint48  public constant DEFAULT_SETTLEMENT_WINDOW      = 30 days;
    // Execution window after settlement: claimant must act within 7 days
    uint48  public constant EXECUTION_WINDOW               = 7 days;
    // Default slash amount in MON (1e18 scaled): 500 MON
    uint128 public constant DEFAULT_SLASH_AMOUNT_MON       = 500e18;
    // Claimant bond in MON (1e18 scaled): 50 MON (burned on rejected claim)
    uint128 public constant CLAIMANT_BOND_MON              = 50e18;

    // ── Immutables ────────────────────────────────────────────────────────────

    IPublisherStake  public immutable publisherStake;
    IScoreRegistry   public immutable scoreRegistry;

    // shMON token for claimant bonds
    address          public immutable shMon;

    // ── State ─────────────────────────────────────────────────────────────────

    // Tunable parameters (governance-minimized: only adjustable within bounds)
    uint32  public apyThresholdBps;
    uint32  public lossTvlDropBps;
    uint48  public settlementWindow;
    uint128 public slashAmountMon;

    // Claims
    uint256                     public claimCount;
    mapping(uint256 => Claim)   private _claims;

    // Active claim guard: one pending claim per (publisher, poolId) at a time
    mapping(bytes32 => uint256) private _activeClaim; // hash(publisher,poolId) => claimId
    mapping(bytes32 => bool)    private _hasActiveClaim;

    // Evidence roots: publisher => poolId => windowStart => merkle root
    mapping(address => mapping(bytes32 => mapping(uint256 => bytes32))) private _evidenceRoots;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address _publisherStake,
        address _scoreRegistry,
        address _shMon
    ) {
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

    // ── Evidence Root ─────────────────────────────────────────────────────────

    /**
     * @notice Post a merkle root of evidence snapshots for a pool/window.
     * @dev    Anyone can post — typically an off-chain indexer or the publisher.
     *         Root commits to an ordered array of EvidenceSnapshot structs
     *         covering a specific time window.
     * @param poolId       Pool identifier
     * @param windowStart  Unix timestamp of window start
     * @param root         Merkle root of EvidenceSnapshot array
     */
    function postEvidenceRoot(
        bytes32 poolId,
        uint256 windowStart,
        bytes32 root
    ) external {
        _evidenceRoots[msg.sender][poolId][windowStart] = root;
        emit EvidenceRootPosted(poolId, msg.sender, windowStart, root);
    }

    /**
     * @notice Retrieve an evidence root.
     */
    function getEvidenceRoot(
        address poster,
        bytes32 poolId,
        uint256 windowStart
    ) external view returns (bytes32) {
        return _evidenceRoots[poster][poolId][windowStart];
    }

    // ── Claim Submission ──────────────────────────────────────────────────────

    /**
     * @notice Submit a deviation claim against a publisher for a pool.
     * @dev    Claimant posts a bond (CLAIMANT_BOND_MON in shMON terms).
     *         Bond is burned if claim is rejected, returned if expired.
     *
     * @param poolId    Pool to dispute
     * @param publisher Publisher to challenge
     * @param reason    SlashReason enum value
     * @param bond      shMON bond amount (must cover CLAIMANT_BOND_MON at current rate)
     */
    function submitClaim(
        bytes32     poolId,
        address     publisher,
        SlashReason reason,
        uint128     bond
    ) external returns (uint256 claimId) {
        // ── Guard: no duplicate active claims
        bytes32 claimKey = keccak256(abi.encodePacked(publisher, poolId));
        if (_hasActiveClaim[claimKey]) revert DuplicateClaim(poolId, publisher);

        // ── Pull bond from claimant
        (bool ok,) = shMon.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), bond)
        );
        require(ok, "Bond transfer failed");

        // ── Snapshot current published score
        IScoreRegistry.PoolScore memory score = scoreRegistry.getLatestScore(poolId);

        uint48 now48      = uint48(block.timestamp);
        uint48 settlesAt  = now48 + settlementWindow;

        claimId = ++claimCount;

        _claims[claimId] = Claim({
            poolId:               poolId,
            publisher:            publisher,
            claimant:             msg.sender,
            submittedAt:          now48,
            settlementEndsAt:     settlesAt,
            claimantBond:         bond,
            publishedApy:         score.baseApy + score.rewardApy,
            publishedRiskScore:   score.riskScore,
            publishedConfidence:  score.confidence,
            publishedTvl:         score.tvlUsd,
            status:               ClaimStatus.Pending,
            reason:               reason
        });

        _activeClaim[claimKey]    = claimId;
        _hasActiveClaim[claimKey] = true;

        emit ClaimSubmitted(claimId, poolId, publisher, msg.sender, reason, settlesAt);
    }

    // ── Claim Execution ───────────────────────────────────────────────────────

    /**
     * @notice Execute a claim after the settlement window has passed.
     * @dev    Caller provides merkle proof of realised snapshots.
     *         If deviation confirmed → slash publisher, reward caller.
     *         If deviation not confirmed → burn claimant bond.
     *
     * @param claimId         Claim to execute
     * @param evidencePoster  Address that posted the evidence root
     * @param windowStart     Window start used when posting evidence root
     * @param realisedApy     Realised APY in bps (from evidence)
     * @param realisedTvl     Realised TVL at end of window (1e6 scaled)
     * @param updateCount     Registry update count at end of window
     * @param proof           Merkle proof of EvidenceSnapshot leaf
     */
    function executeClaim(
        uint256 claimId,
        address evidencePoster,
        uint256 windowStart,
        uint32  realisedApy,
        uint128 realisedTvl,
        uint32  updateCount,
        bytes32[] calldata proof
    ) external {
        Claim storage claim = _claims[claimId];

        if (claim.submittedAt == 0)              revert ClaimNotFound(claimId);
        if (claim.status != ClaimStatus.Pending) revert ClaimNotPending(claimId, claim.status);

        uint48 now48 = uint48(block.timestamp);

        // ── Settlement window must have passed
        if (now48 < claim.settlementEndsAt) {
            revert SettlementWindowNotPassed(claim.settlementEndsAt, now48);
        }

        // ── Execution window must not have expired
        if (now48 > claim.settlementEndsAt + EXECUTION_WINDOW) {
            // Expired — return bond to claimant
            claim.status = ClaimStatus.Expired;
            _clearActiveClaim(claim.publisher, claim.poolId);
            _transferShMon(claim.claimant, claim.claimantBond);
            emit ClaimExpired(claimId, claim.claimantBond);
            return;
        }

        // ── Verify merkle proof
        bytes32 leaf = _buildLeaf(claim.settlementEndsAt, realisedApy, realisedTvl, updateCount);
        bytes32 root = _evidenceRoots[evidencePoster][claim.poolId][windowStart];
        if (!_verifyProof(proof, root, leaf)) revert InvalidProof(leaf, root);

        // ── Evaluate deviation
        bool slashTriggered = _evaluateDeviation(claim, realisedApy, realisedTvl, updateCount);

        _clearActiveClaim(claim.publisher, claim.poolId);

        if (slashTriggered) {
            claim.status = ClaimStatus.Executed;
            publisherStake.slash(claim.publisher, slashAmountMon, msg.sender);

            // Return claimant bond
            _transferShMon(claim.claimant, claim.claimantBond);

            emit ClaimExecuted(claimId, claim.publisher, msg.sender, claim.reason, slashAmountMon);
        } else {
            claim.status = ClaimStatus.Rejected;

            // Burn claimant bond (griefing deterrent)
            _burnShMon(claim.claimantBond);

            emit ClaimRejected(claimId, claim.claimant, claim.claimantBond);
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        if (_claims[claimId].submittedAt == 0) revert ClaimNotFound(claimId);
        return _claims[claimId];
    }

    function hasActiveClaim(address publisher, bytes32 poolId)
        external view returns (bool, uint256 claimId)
    {
        bytes32 key = keccak256(abi.encodePacked(publisher, poolId));
        return (_hasActiveClaim[key], _activeClaim[key]);
    }

    // ── Internal: Deviation Logic ─────────────────────────────────────────────

    /**
     * @dev Evaluates whether any slash condition is met.
     *      Returns true if publisher should be slashed.
     */
    function _evaluateDeviation(
        Claim storage claim,
        uint32  realisedApy,
        uint128 realisedTvl,
        uint32  updateCount
    ) internal view returns (bool) {

        // ── Condition 1: APY Deviation
        if (claim.reason == SlashReason.ApyDeviation) {
            uint32 published = claim.publishedApy;
            uint32 delta     = published > realisedApy
                ? published - realisedApy
                : realisedApy - published;
            return delta > apyThresholdBps;
        }

        // ── Condition 2: Risk Score Flip (loss event despite safe score)
        if (claim.reason == SlashReason.RiskScoreFlip) {
            if (claim.publishedRiskScore < SAFE_RISK_THRESHOLD) return false;
            if (claim.publishedTvl == 0) return false;

            // TVL drop check: (publishedTvl - realisedTvl) / publishedTvl > threshold
            if (realisedTvl >= claim.publishedTvl) return false;
            uint256 dropBps = ((uint256(claim.publishedTvl) - realisedTvl) * 10_000)
                              / uint256(claim.publishedTvl);
            return dropBps > lossTvlDropBps;
        }

        // ── Condition 3: Confidence Fraud (high confidence, stale data)
        if (claim.reason == SlashReason.ConfidenceFraud) {
            if (claim.publishedConfidence < MIN_CONFIDENCE_FRAUD_THRESHOLD) return false;
            // If updateCount at settlement equals updateCount at claim submission,
            // publisher made zero updates during the entire settlement window
            IScoreRegistry.PoolScore memory latest = scoreRegistry.getLatestScore(claim.poolId);
            return updateCount == latest.updateCount;
        }

        return false;
    }

    // ── Internal: Merkle ──────────────────────────────────────────────────────

    function _buildLeaf(
        uint48  timestamp,
        uint32  realisedApy,
        uint128 tvlUsd,
        uint32  updateCount
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(timestamp, realisedApy, tvlUsd, updateCount));
    }

    function _verifyProof(
        bytes32[] calldata proof,
        bytes32            root,
        bytes32            leaf
    ) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == root;
    }

    // ── Internal: Helpers ─────────────────────────────────────────────────────

    function _clearActiveClaim(address publisher, bytes32 poolId) internal {
        bytes32 key = keccak256(abi.encodePacked(publisher, poolId));
        _hasActiveClaim[key] = false;
        _activeClaim[key]    = 0;
    }

    function _transferShMon(address to, uint128 amount) internal {
        (bool ok,) = shMon.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        require(ok, "shMON transfer failed");
    }

    function _burnShMon(uint128 amount) internal {
        (bool ok,) = shMon.call(
            abi.encodeWithSignature("burn(uint256)", amount)
        );
        require(ok, "shMON burn failed");
    }
}
