#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const simulation = require("../dist/berth-simulation.js");

const baseline = simulation.runReplications(simulation.BASELINE, 2026, 12);
const repeated = simulation.runReplications(simulation.BASELINE, 2026, 12);
assert.deepEqual(repeated, baseline, "fixed seed and configuration must reproduce identical summaries");
assert.equal(baseline.replications, 12);
for (const metric of Object.values(baseline.metrics)) {
  for (const key of ["mean", "min", "max", "p50", "p95"]) {
    assert.ok(Number.isFinite(metric[key]), "simulation summary values must be finite");
  }
}
assert.ok(baseline.metrics.utilizationPercent.mean >= 0 && baseline.metrics.utilizationPercent.mean <= 100,
  "utilization must stay between zero and one hundred percent");

const outageScenario = simulation.runReplications({
  ...simulation.BASELINE,
  closureBerths: 1,
  closureStartHour: 12,
  closureDurationHours: 48
}, 2026, 12);
assert.equal(outageScenario.metrics.arrivals.mean, baseline.metrics.arrivals.mean,
  "a berth closure must not change the independently seeded arrival process");
assert.ok(outageScenario.metrics.averageWaitHours.mean > baseline.metrics.averageWaitHours.mean,
  "a temporary capacity loss should increase waiting in this fixed regression scenario");

const fullClosure = simulation.runReplications({
  ...simulation.BASELINE,
  closureBerths: 4,
  closureStartHour: 0,
  closureDurationHours: 168
}, 2026, 4);
assert.equal(fullClosure.metrics.utilizationPercent.mean, 0,
  "a full measurement-window closure has no open berth-hours for service");
assert.ok(fullClosure.metrics.averageWaitHours.mean > 0,
  "vessels arriving during a full closure wait until it ends");

assert.throws(() => simulation.normalizeScenario({ ...simulation.BASELINE, berths: 0 }), /Available berths/);
assert.throws(() => simulation.normalizeScenario({ ...simulation.BASELINE, closureBerths: 5 }), /Closed berths/);
assert.throws(() => simulation.normalizeScenario({ ...simulation.BASELINE, capacityFactor: 0.2 }), /Capacity factor/);

console.log(JSON.stringify({
  status: "passed",
  reproducible_replications: baseline.replications,
  baseline_average_wait_hours: Number(baseline.metrics.averageWaitHours.mean.toFixed(3)),
  outage_average_wait_hours: Number(outageScenario.metrics.averageWaitHours.mean.toFixed(3)),
  full_closure_average_wait_hours: Number(fullClosure.metrics.averageWaitHours.mean.toFixed(3)),
  checks: ["reproducibility", "finite outputs", "utilization bounds", "arrival stream independence", "closure wait impact", "full closure", "input ranges"]
}, null, 2));
