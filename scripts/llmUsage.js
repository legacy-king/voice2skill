#!/usr/bin/env node
/**
 * LLM usage report from llm_calls (one row per provider attempt). Shows when a free tier is
 * running out: rising 429s on one provider, failovers to the next, latency, tokens.
 *
 * Usage: node scripts/llmUsage.js [days=7]
 */
const pool = require('../config/db');

async function main() {
  const days = Math.min(90, Math.max(1, Number(process.argv[2]) || 7));
  const { rows } = await pool.query(
    `SELECT created_at::date AS day, provider, task,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE ok)::int AS ok,
            COUNT(*) FILTER (WHERE error_code = '429')::int AS rate_limited,
            COUNT(*) FILTER (WHERE NOT ok AND error_code <> '429')::int AS other_errors,
            ROUND(AVG(latency_ms) FILTER (WHERE ok))::int AS avg_ms,
            COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens
       FROM llm_calls
      WHERE created_at >= CURRENT_DATE - ($1::int - 1)
      GROUP BY 1, 2, 3
      ORDER BY 1 DESC, 2, 3`,
    [days]
  );
  if (!rows.length) {
    console.log(`No LLM calls in the last ${days} day(s).`);
    return;
  }
  console.log(`LLM calls, last ${days} day(s)\n`);
  console.table(rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    provider: r.provider,
    task: r.task,
    calls: r.calls,
    ok: r.ok,
    '429': r.rate_limited,
    'other errors': r.other_errors,
    'avg ms': r.avg_ms,
    'tokens in': r.prompt_tokens,
    'tokens out': r.completion_tokens
  })));
  const { rows: codes } = await pool.query(
    `SELECT provider, error_code, COUNT(*)::int AS n FROM llm_calls
      WHERE NOT ok AND created_at >= CURRENT_DATE - ($1::int - 1)
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
    [days]
  );
  if (codes.length) {
    console.log('Top errors:');
    for (const c of codes) console.log(`  ${c.provider} ${c.error_code}: ${c.n}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`✗ ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
