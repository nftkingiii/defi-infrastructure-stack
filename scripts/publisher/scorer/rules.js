/**
 * publisher/scorer/rules.js
 * Deterministic rule-based risk scoring.
 * Produces riskScore (0-100), confidence (0-100), and aiScore (0-100).
 *
 * All inputs come from the enriched pool object.
 * No external calls — pure computation.
 */

// ── Weights ───────────────────────────────────────────────────────────────────
// Each factor contributes a score from 0–100 weighted by its importance
const WEIGHTS = {
  tvl:          0.25,   // size = safety
  auditScore:   0.20,   // security posture
  apyStability: 0.15,   // yield reliability
  protocolAge:  0.15,   // track record
  ilRisk:       0.10,   // impermanent loss exposure
  utilisation:  0.10,   // for lending pools
  rewardRatio:  0.05,   // emission dependency
};

// ── TVL score ─────────────────────────────────────────────────────────────────
function tvlScore(tvlUsd) {
  if (tvlUsd >= 100_000_000) return 100;
  if (tvlUsd >= 50_000_000)  return 90;
  if (tvlUsd >= 10_000_000)  return 75;
  if (tvlUsd >= 1_000_000)   return 55;
  if (tvlUsd >= 100_000)     return 35;
  return 15;
}

// ── Audit score ───────────────────────────────────────────────────────────────
function auditScore(audits, auditLinks) {
  const count = audits || auditLinks?.length || 0;
  if (count >= 3) return 100;
  if (count === 2) return 80;
  if (count === 1) return 55;
  return 10;   // unaudited is a major red flag
}

// ── APY stability score ───────────────────────────────────────────────────────
// Lower 30d volatility = more stable yield = higher score
function apyStabilityScore(apyVolatility30d, totalApy) {
  if (totalApy === 0) return 50;
  // Volatility as % of total APY
  const relativeVol = apyVolatility30d / Math.max(totalApy, 1);
  if (relativeVol < 0.1)  return 100;
  if (relativeVol < 0.25) return 80;
  if (relativeVol < 0.5)  return 60;
  if (relativeVol < 1.0)  return 40;
  return 20;
}

// ── Protocol age score ────────────────────────────────────────────────────────
function protocolAgeScore(ageDays) {
  if (ageDays >= 730) return 100;   // 2+ years
  if (ageDays >= 365) return 80;    // 1+ year
  if (ageDays >= 180) return 60;    // 6+ months
  if (ageDays >= 90)  return 40;    // 3+ months
  if (ageDays >= 30)  return 25;    // 1+ month
  return 10;                         // brand new
}

// ── IL risk score ─────────────────────────────────────────────────────────────
// ilRisk field from DefiLlama (0=none, 20=low, 50=medium)
function ilRiskScore(ilRisk) {
  return Math.max(0, 100 - ilRisk);
}

// ── Utilisation score (lending pools) ─────────────────────────────────────────
// Sweet spot is 40–80% utilisation. Too high = liquidity risk.
function utilisationScore(utilisationRate, category) {
  if (category !== 'Lending') return 70;   // neutral for non-lending
  const pct = utilisationRate / 100;       // bps to %
  if (pct >= 40 && pct <= 80) return 90;
  if (pct >= 20 && pct < 40)  return 70;
  if (pct > 80 && pct <= 90)  return 50;
  if (pct > 90)               return 20;   // dangerously high
  return 60;
}

// ── Reward ratio score ────────────────────────────────────────────────────────
// High emissions dependency = risky when emissions end
function rewardRatioScore(baseApy, totalApy) {
  if (totalApy === 0) return 50;
  const ratio = baseApy / Math.max(totalApy, 1);
  if (ratio >= 0.8)  return 100;   // mostly organic yield
  if (ratio >= 0.5)  return 75;
  if (ratio >= 0.25) return 50;
  if (ratio >= 0.1)  return 30;
  return 10;                        // almost entirely emissions
}

// ── Confidence score ──────────────────────────────────────────────────────────
// Reflects data completeness, not risk
function computeConfidence(pool) {
  let score = 100;

  if (!pool.tvlUsd || pool.tvlUsd === 0)          score -= 30;
  if (pool.apyVolatility30d === 0)                 score -= 15;  // likely no history
  if (!pool.audits && !pool.auditLinks?.length)    score -= 20;
  if (!pool.protocolAgeDays || pool.protocolAgeDays === 0) score -= 15;
  if (pool.utilisationRate === 0 && pool.category === 'Lending') score -= 10;
  if (!pool.underlyingTokens?.length)              score -= 10;

  return Math.max(10, Math.min(100, score));
}

// ── Main scoring function ─────────────────────────────────────────────────────

function scorePool(pool) {
  const factors = {
    tvl:          tvlScore(pool.tvlUsd),
    auditScore:   auditScore(pool.audits, pool.auditLinks),
    apyStability: apyStabilityScore(pool.apyVolatility30d, pool.totalApy),
    protocolAge:  protocolAgeScore(pool.protocolAgeDays || 0),
    ilRisk:       ilRiskScore(pool.ilRisk || 0),
    utilisation:  utilisationScore(pool.utilisationRate || 0, pool.category),
    rewardRatio:  rewardRatioScore(pool.baseApy, pool.totalApy),
  };

  // Weighted average
  let riskScore = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    riskScore += (factors[key] || 0) * weight;
  }
  riskScore = Math.round(Math.max(0, Math.min(100, riskScore)));

  const confidence = computeConfidence(pool);

  // Risk label
  let riskLabel;
  if (riskScore >= 80)      riskLabel = 'V.Low';
  else if (riskScore >= 65) riskLabel = 'Low';
  else if (riskScore >= 45) riskLabel = 'Med';
  else if (riskScore >= 25) riskLabel = 'High';
  else                      riskLabel = 'V.High';

  return {
    riskScore,
    confidence,
    riskLabel,
    factors,   // kept for AI augmentation context
  };
}

module.exports = { scorePool, tvlScore, auditScore, apyStabilityScore, protocolAgeScore };
