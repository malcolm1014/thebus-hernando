/**
 * Optionally rewrites the rule-based query engine's already-correct
 * answer into friendlier, more natural language via xAI's Grok, for
 * riders whose device is online. This is a REPHRASING step only -- the
 * factual answer (stop names, routes, times) is computed entirely
 * offline by queryEngine.js before this is ever called, and this
 * module's whole job is tone, never transit facts. See config.js's
 * xaiApiKey/xaiModel doc comment for why this is a separate provider
 * from enrich.js's Groq-based alias enrichment, and PRIVACY_POLICY.md
 * for what this does and doesn't send off-device.
 *
 * Entirely optional and fully non-blocking for correctness: with no
 * XAI_API_KEY configured, `enhanceAnswer` always resolves to `null`
 * immediately, and the caller (server.js's /api/enhance-answer, and the
 * frontend beyond it) falls back to the original factual answer
 * unchanged -- exactly this app's original fully-offline behavior. A
 * slow, failed, or malformed response from Grok resolves to `null` the
 * same way, never throws, and never blocks a rider on a "nicer" answer
 * for longer than REQUEST_TIMEOUT_MS.
 */
const config = require('./config');

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 6000;
const MAX_QUERY_LEN = 500;
const MAX_ANSWER_LEN = 2000;

function buildPrompt(query, factualAnswer) {
  return `You are TriBus, a helpful regional transit assistant for Hernando, Pasco, and Hillsborough (HART/Tampa) counties in Florida.

A rider asked: "${query}"

Your own transit-schedule system already computed this exact, correct, factual answer:
"""
${factualAnswer}
"""

Rewrite it as a friendlier, more natural response, in 1-3 short sentences. Do NOT invent, add, or change ANY stop name, route name, time, or number that isn't already present in the factual answer above -- your only job is tone and phrasing, not adding transit facts. If the factual answer is an error or help message rather than real transit data, keep your rewrite equally short and just as clear.`;
}

/** @returns {Promise<string | null>} the rephrased answer, or null when not configured / the request failed / timed out / the response was empty. */
async function enhanceAnswer(query, factualAnswer) {
  if (!config.xaiApiKey) return null;
  if (!query || !factualAnswer) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(XAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.xaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.xaiModel,
        messages: [{ role: 'user', content: buildPrompt(query.slice(0, MAX_QUERY_LEN), factualAnswer.slice(0, MAX_ANSWER_LEN)) }],
        temperature: 0.5,
        max_tokens: 300,
      }),
    });
    if (!res.ok) {
      console.error(`[grokAnswer] xAI request failed: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!text || !text.trim()) return null;
    return text.trim();
  } catch (err) {
    console.error('[grokAnswer] request failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enhanceAnswer };
