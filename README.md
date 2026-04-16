# Governance-Minimized DeFi Infrastructure

A trust-minimized oracle and risk parameter stack for immutable smart contracts on Monad Network.

Built around three propositions: bridges sturdy enough for permanent integration, oracles with economic skin-in-the-game, and a perpetuals DEX as an empirical calibration instrument.

---

## Deployed Contracts (Monad Testnet)

| Contract | Address |
|---|---|
| ScoreRegistry | [0x1172ce3bA6C6DcdD35C6b14638bE3d6287b8B0B0](https://testnet.monadscan.com/address/0x1172ce3bA6C6DcdD35C6b14638bE3d6287b8B0B0) |
| PublisherStake | [0x9Db11F94f2E082D84AccEf885687d1D99D681743](https://testnet.monadscan.com/address/0x9Db11F94f2E082D84AccEf885687d1D99D681743) |
| DeviationAdjudicator | [0x0191b2b80A39D945e67412a1652FC0121fc1b43B](https://testnet.monadscan.com/address/0x0191b2b80A39D945e67412a1652FC0121fc1b43B) |
| PerpRiskParams | [0xEDdfEA29645FEd0ACbaB25668a94ef5A98e7A7B9](https://testnet.monadscan.com/address/0xEDdfEA29645FEd0ACbaB25668a94ef5A98e7A7B9) |
| PerpsDEX | [0xD8e4f84f543836832b9CaBfC440488CE74Fb8133](https://testnet.monadscan.com/address/0xD8e4f84f543836832b9CaBfC440488CE74Fb8133) |
| MockUSDC | [0x75761710de793134faCd2933fb495217eb89fb7f](https://testnet.monadscan.com/address/0x75761710de793134faCd2933fb495217eb89fb7f) |
| MockShMON | [0x93B322334Fa8D7aC6799B5f9483EC7bDdaC2786D](https://testnet.monadscan.com/address/0x93B322334Fa8D7aC6799B5f9483EC7bDdaC2786D) |

Chain: Monad Testnet (chainId 10143)
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
ScoreRegistry        — immutable, no admin keys
↑
PublisherStake       — shMON collateral, slash on deviation
↑
DeviationAdjudicator — permissionless watchdog, merkle proof evidence
↓
PerpRiskParams       — deterministic risk derivation, circuit breaker
↓
Perps DEX            — research instrument, generates calibration data
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

- [x] ScoreRegistry
- [x] PublisherStake
- [x] DeviationAdjudicator
- [x] PerpRiskParams
- [x] Deployment scripts
- [x] Test suite (47/47 passing)
- [x] Off-chain evidence indexer
- [x] Publisher agent (DefiLlama + on-chain fetcher, rule-based scorer)
- [x] Deployed to Monad Testnet
- [x] PerpsDEX prototype (research instrument)
- [ ] Frontend dashboard
- [ ] Mainnet deployment
- [ ] Audit

---

## Further Reading

The full thesis behind this stack is in [`docs/thesis.docx`](docs/thesis.docx).

---

## License

MIT