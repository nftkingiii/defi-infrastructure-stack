/**
 * publisher/scorer/ai.js
 * Calls Claude API to augment rule-based scores with reasoning.
 * Used as a secondary confidence signal and to catch blind spots
 * that deterministic rules miss (e.g. protocol reputation, recent incidents).
 *
 * Returns an adjusted riskScore and confidence, plus a reasoning string
 * stored off-chain for audit purposes.
 */

const axios  = require('axios');
const logger = require('../logger');

const MODEL      = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 512;
const API_URL    = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are a DeFi risk analyst scoring yield pools for a trust-minimized oracle.
Your output must be a JSON object only, no prose, no markdown.
Required fields:
  riskScore    (integer 0-100, 100 = safest)
  confidence   (integer 0-100, reflects data quality and certainty)
  adjustment   (integer -20 to +20, your delta from the rule-based score)
  reasoning    (string, max 100 words, key risk factors)
Only output valid JSON. No preamble, no explanation outside the JSON.`;

/**
 * Augments a rule-based score with Claude's reasoning.
 * Returns { riskScore, confidence, reasoning, used } where used=false if API unavailable.
 */
async function augmentScore(pool, ruleResult) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.debug('[AI Scorer] No API key — skipping AI augmentation for %s', pool.protocolSlug);
    return { ...ruleResult, reasoning: 'Rule-based only (no API key)', used: false };
  }

  const prompt = buildPrompt(pool, ruleResult);

  try {
    const res = await axios.post(
      API_URL,
      {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 15_000,
      }
    );

    const text = res.data?.content?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Blend: 70% rule-based, 30% AI adjustment
    const blendedScore = Math.round(
      ruleResult.riskScore * 0.7 +
      Math.max(0, Math.min(100, ruleResult.riskScore + (parsed.adjustment || 0))) * 0.3
    );

    // AI confidence adjusts the final confidence
    const blendedConfidence = Math.round(
      (ruleResult.confidence + (parsed.confidence || ruleResult.confidence)) / 2
    );

    logger.debug('[AI Scorer] %s: rule=%d ai_adj=%d blended=%d',
      pool.protocolSlug, ruleResult.riskScore, parsed.adjustment || 0, blendedScore);

    return {
      riskScore:  Math.max(0, Math.min(100, blendedScore)),
      confidence: Math.max(0, Math.min(100, blendedConfidence)),
      riskLabel:  ruleResult.riskLabel,
      reasoning:  parsed.reasoning || '',
      used:       true,
    };

  } catch (e) {
    logger.warn('[AI Scorer] API call failed for %s: %s — using rule-based score',
      pool.protocolSlug, e.message);
    return { ...ruleResult, reasoning: 'Rule-based only (AI call failed)', used: false };
  }
}

function buildPrompt(pool, ruleResult) {
  return `Evaluate this DeFi yield pool and return a risk score JSON.

Pool: ${pool.protocolName} (${pool.protocolSlug})
Category: ${pool.category}
Chain: ${pool.chain}
Symbol: ${pool.symbol}

Metrics:
- TVL: $${(pool.tvlUsd / 1e6).toFixed(2)}M
- Base APY: ${(pool.baseApy / 100).toFixed(2)}%
- Reward APY: ${(pool.rewardApy / 100).toFixed(2)}%
- Total APY: ${(pool.totalApy / 100).toFixed(2)}%
- 30d APY Volatility: ${(pool.apyVolatility30d / 100).toFixed(2)}%
- IL Risk: ${pool.ilRisk || 0}/100
- Audits: ${pool.audits || 0}
- Protocol Age: ${pool.protocolAgeDays || 'unknown'} days
- Utilisation Rate: ${(pool.utilisationRate / 100).toFixed(1)}%
- Stablecoin: ${pool.stablecoin}

Rule-based score breakdown:
${JSON.stringify(ruleResult.factors, null, 2)}

Current rule-based riskScore: ${ruleResult.riskScore}/100
Current confidence: ${ruleResult.confidence}/100

Provide your assessment as JSON only.`;
}

module.exports = { augmentScore };
