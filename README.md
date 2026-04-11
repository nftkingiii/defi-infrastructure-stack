# Governance-Minimized DeFi Infrastructure

A trust-minimized oracle and risk parameter stack for immutable smart contracts on Monad Network.

Built around three propositions: bridges sturdy enough for permanent integration, oracles with economic skin-in-the-game, and a perpetuals DEX as an empirical calibration instrument.

---

## Overview

Most DeFi infrastructure relies on upgrade keys, governance votes, and multisig committees to manage risk. This model is incompatible with immutable contracts — contracts that cannot be patched and therefore cannot afford to depend on infrastructure that can change under them.

This stack replaces governance-mediated trust with economic trust. Publishers stake **shMON** collateral to earn write access to a yield intelligence registry. If their published scores diverge materially from realised outcomes, their stake is slashed by a permissionless watchdog. A perpetuals DEX consumes the registry to derive risk parameters deterministically — no admin can override a leverage limit or relax a margin requirement.

---

## Contracts

### `ScoreRegistry.sol`
Immutable on-chain registry for yield intelligence scores. No admin keys, no upgradeability. Stores APY components, TVL, risk scores, volatility, IL risk, liquidity depth, utilisation rate, audit scores, and confidence levels per pool. Write access gated entirely by `PublisherStake`.

### `PublisherStake.sol`
shMON collateral contract that gates write access to the registry. Publishers deposit shMON (worth at least a MON-denominated minimum at current exchange rate) to register. They earn MEV-enhanced staking yield on locked collateral while active. Slash execution reduces stake and bans publishers after three offences.

### `DeviationAdjudicator.sol`
Permissionless watchdog. Anyone can submit a deviation claim against a publisher with a small bond. After a 30-day settlement window, the claimant submits a merkle proof of realised outcomes. If the deviation threshold is breached, the publisher is slashed and the watchdog earns a bounty from the slashed stake.

**Three slash conditions:**
- **APY deviation** — published APY differs from realised by more than 500bps
- **Risk score flip** — pool rated safe suffers a 20%+ TVL loss event
- **Confidence fraud** — high confidence claimed but zero updates made during the settlement window

### `PerpRiskParams.sol`
Consumes `ScoreRegistry` to derive live risk parameters for a perpetuals DEX. All derivation is deterministic — same oracle inputs always produce the same parameters. Includes a circuit breaker that halts trading on any pool whose score becomes stale or whose confidence drops below the minimum threshold.

**Parameters derived per pool:**
- Max open interest (scaled from TVL × risk score × liquidity depth)
- Max leverage (scaled from risk score with IL haircut)
- Initial and maintenance margin requirements (inflated by APY volatility and low confidence)
- Funding rate multiplier (scaled by 30-day APY volatility)
- Liquidation penalty (inversely related to risk score)
- Stale price threshold (tightened by high volatility)

---

## Architecture

```
ScoreRegistry        — immutable, no admin keys
       ↑
PublisherStake       — shMON collateral, slash on deviation
       ↑
DeviationAdjudicator — permissionless watchdog, merkle proof evidence
       ↓
PerpRiskParams       — deterministic risk derivation, circuit breaker
       ↓
Perps DEX            — research instrument, generates calibration data
```

Every layer is governance-minimized. The registry is immutable. The stake contract enforces behavior economically. The adjudicator is permissionless. The DEX reads parameters it can trust because the publisher has something to lose.

---

## Design Decisions

**Why shMON instead of MON?**
Publishers earn MEV-enhanced staking yield on locked collateral, which reduces the opportunity cost of participation and widens the publisher set. Slash amounts are denominated in MON but computed at the live shMON/MON exchange rate at execution time, keeping real-value penalties consistent as shMON appreciates.

**Why deterministic parameter derivation?**
Governance-adjustable risk parameters are a vector for manipulation. By deriving all parameters deterministically from oracle data, the only way to change a risk parameter is to change the underlying data — which requires either the market to move or the publisher to update their score, both of which are economically accountable actions.

**Why a perps DEX as a research instrument?**
Risk parameters like max OI cannot be reliably derived from theory alone. Running real positions against the derived parameters generates empirical data on liquidation rates, funding rate distributions, and scoring model blind spots. This feedback loop improves the oracle without governance intervention.

---

## Status

These contracts are a working specification and research prototype. They have not been audited. Do not deploy to mainnet without a full security review.

- [x] ScoreRegistry
- [x] PublisherStake
- [x] DeviationAdjudicator
- [x] PerpRiskParams
- [ ] Deployment scripts
- [ ] Test suite
- [ ] Off-chain evidence indexer
- [ ] Perps DEX prototype

---

## Further Reading

The full thesis behind this stack — covering the problem with governed infrastructure, the three propositions, honest risk analysis, and why Monad is the right environment — is in [`docs/thesis.docx`](docs/thesis.docx).

---

## License

MIT
