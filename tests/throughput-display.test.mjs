import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { invalidTpsTitle } from '../apps/web/src/lib/format.ts';

// Execute the production aggregation without importing routes' live database dependencies.
const source = readFileSync(new URL('../apps/server/src/routes.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function percentile(');
const end = source.indexOf('export async function registerRoutes');
const summarize = vm.runInNewContext(source.slice(start, end) + '\nsummarize');
const row = (patch = {}) => ({ status: 'ok', valid: 1, avg_tps: 90, tps: null, ttft_ms: 12000, total_ms: 12500, ...patch });

test('sample count matches exactly the overall-throughput median population', () => {
  const result = summarize([row(), row({ avg_tps: 110 }), row({ valid: 0, avg_tps: 900 }), row({ avg_tps: null }), row({ status: 'error' })]);
  assert.equal(result.avg_tps.count, 2);
  assert.equal(result.avg_tps.p50, 100);
  assert.equal(result.total, 5);
  assert.equal(result.success_rate, 80);
});

test('empty throughput population explicitly reports zero samples', () => {
  const result = summarize([row({ avg_tps: null }), row({ valid: 0 })]);
  assert.equal(result.avg_tps.count, 0);
  assert.equal(result.avg_tps.p50, null);
});

test('non-finite values are not counted or aggregated', () => {
  const result = summarize([row(), row({ avg_tps: Infinity }), row({ avg_tps: NaN })]);
  assert.equal(result.avg_tps.count, 1);
  assert.equal(result.avg_tps.avg, 90);
});

test('invalid-measurement explanation recommends retesting without asserting cache or physical limits', () => {
  const text = invalidTpsTitle();
  assert.match(text, /建议复测/);
  assert.match(text, /经验/);
  assert.doesNotMatch(text, /缓存|物理上限/);
});
