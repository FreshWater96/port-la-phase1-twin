/* Reproducible, assumption-driven berth queue simulation. No live or Port operations data is used. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PortBerthSimulation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WARMUP_HOURS = 24;
  const DEFAULT_REPLICATIONS = 20;
  const BASELINE = Object.freeze({
    arrivalRatePerHour: 0.2,
    berths: 4,
    meanServiceHours: 10,
    serviceDistribution: 'exponential',
    capacityFactor: 0.85,
    closureBerths: 0,
    closureStartHour: 36,
    closureDurationHours: 0,
    horizonHours: 168
  });

  function finite(value, name) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new TypeError(name + ' must be a finite number.');
    return n;
  }

  function normalizeScenario(input) {
    const source = input || {};
    const scenario = {
      arrivalRatePerHour: finite(source.arrivalRatePerHour, 'Arrival rate'),
      berths: finite(source.berths, 'Available berths'),
      meanServiceHours: finite(source.meanServiceHours, 'Mean service time'),
      serviceDistribution: String(source.serviceDistribution || 'exponential'),
      capacityFactor: finite(source.capacityFactor, 'Capacity factor'),
      closureBerths: finite(source.closureBerths === undefined ? 0 : source.closureBerths, 'Closed berths'),
      closureStartHour: finite(source.closureStartHour === undefined ? 0 : source.closureStartHour, 'Closure start'),
      closureDurationHours: finite(source.closureDurationHours === undefined ? 0 : source.closureDurationHours, 'Closure duration'),
      horizonHours: finite(source.horizonHours === undefined ? 168 : source.horizonHours, 'Analysis horizon')
    };
    if (scenario.arrivalRatePerHour < 0.01 || scenario.arrivalRatePerHour > 4) throw new RangeError('Arrival rate must be between 0.01 and 4 vessels per hour.');
    if (!Number.isInteger(scenario.berths) || scenario.berths < 1 || scenario.berths > 10) throw new RangeError('Available berths must be an integer from 1 to 10.');
    if (scenario.meanServiceHours < 2 || scenario.meanServiceHours > 72) throw new RangeError('Mean service time must be between 2 and 72 hours.');
    if (!['exponential', 'erlang2'].includes(scenario.serviceDistribution)) throw new RangeError('Choose exponential or Erlang-2 service times.');
    if (scenario.capacityFactor < 0.5 || scenario.capacityFactor > 1) throw new RangeError('Capacity factor must be between 50% and 100%.');
    if (!Number.isInteger(scenario.closureBerths) || scenario.closureBerths < 0 || scenario.closureBerths > scenario.berths) throw new RangeError('Closed berths must be a whole number between zero and the available berth count.');
    if (scenario.horizonHours < 24 || scenario.horizonHours > 336) throw new RangeError('Analysis horizon must be between 24 and 336 hours.');
    if (scenario.closureStartHour < 0 || scenario.closureStartHour > scenario.horizonHours) throw new RangeError('Closure start must fall within the analysis horizon.');
    if (scenario.closureDurationHours < 0 || scenario.closureDurationHours > scenario.horizonHours - scenario.closureStartHour) throw new RangeError('Closure duration must end within the analysis horizon.');
    return scenario;
  }

  function mulberry32(seed) {
    let state = (Number(seed) >>> 0) || 0x6d2b79f5;
    return function () {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function exponential(rng, rate) {
    return -Math.log(Math.max(Number.EPSILON, 1 - rng())) / rate;
  }

  function serviceTime(rng, scenario) {
    let hours;
    if (scenario.serviceDistribution === 'erlang2') {
      const phaseRate = 2 / scenario.meanServiceHours;
      hours = exponential(rng, phaseRate) + exponential(rng, phaseRate);
    } else {
      hours = exponential(rng, 1 / scenario.meanServiceHours);
    }
    return hours / scenario.capacityFactor;
  }

  function oneReplication(scenario, seed) {
    const arrivalRng = mulberry32((seed ^ 0xa341316c) >>> 0);
    const serviceRng = mulberry32((seed ^ 0xc8013ea4) >>> 0);
    const measurementStart = WARMUP_HOURS;
    const measurementEnd = measurementStart + scenario.horizonHours;
    const closureStart = measurementStart + scenario.closureStartHour;
    const closureEnd = Math.min(measurementEnd, closureStart + scenario.closureDurationHours);
    const hasClosure = scenario.closureBerths > 0 && scenario.closureDurationHours > 0;
    const arrivals = [];
    let arrivalAt = exponential(arrivalRng, scenario.arrivalRatePerHour);
    while (arrivalAt < measurementEnd) {
      arrivals.push(arrivalAt);
      arrivalAt += exponential(arrivalRng, scenario.arrivalRatePerHour);
    }

    const servers = Array.from({ length: scenario.berths }, () => ({ finish: Infinity, remaining: 0, paused: false, job: null }));
    const queue = [];
    let arrivalIndex = 0;
    let time = 0;
    let busyBerthHours = 0;
    let openBerthHours = 0;
    let queueArea = 0;
    let maximumQueue = 0;
    let arrivalsInWindow = 0;
    let completionsInWindow = 0;
    const waits = [];

    function closureActive(at) { return hasClosure && at >= closureStart && at < closureEnd; }
    function isClosed(serverIndex, at) { return closureActive(at) && serverIndex >= scenario.berths - scenario.closureBerths; }
    function dispatch(at) {
      for (let i = 0; i < servers.length && queue.length; i += 1) {
        const server = servers[i];
        if (server.job || isClosed(i, at)) continue;
        const job = queue.shift();
        if (job.measured) waits.push(Math.max(0, at - job.arrival));
        server.job = job;
        server.paused = false;
        server.remaining = 0;
        server.finish = at + serviceTime(serviceRng, scenario);
      }
    }

    function integrate(to) {
      const from = Math.max(time, measurementStart);
      const end = Math.min(to, measurementEnd);
      const dt = Math.max(0, end - from);
      if (!dt) return;
      maximumQueue = Math.max(maximumQueue, queue.length);
      queueArea += queue.length * dt;
      const closed = closureActive((from + end) / 2) ? scenario.closureBerths : 0;
      openBerthHours += Math.max(0, scenario.berths - closed) * dt;
      busyBerthHours += servers.reduce((sum, server) => sum + (server.job && !server.paused ? dt : 0), 0);
    }

    function drainActive() {
      return arrivalIndex < arrivals.length || queue.length > 0 || servers.some(server => server.job);
    }

    let iterations = 0;
    while (drainActive()) {
      if (++iterations > 2000000) throw new Error('Simulation event limit reached.');
      const nextArrival = arrivalIndex < arrivals.length ? arrivals[arrivalIndex] : Infinity;
      const nextFinish = Math.min(...servers.map(server => server.paused ? Infinity : server.finish));
      const nextClosure = hasClosure && time < closureStart ? closureStart : (hasClosure && time < closureEnd ? closureEnd : Infinity);
      const next = Math.min(nextArrival, nextFinish, nextClosure);
      if (!Number.isFinite(next)) break;
      integrate(next);
      time = next;

      // Complete service scheduled exactly at a closure boundary before changing berth availability.
      servers.forEach(server => {
        if (server.job && !server.paused && server.finish <= time + 1e-9) {
          if (time >= measurementStart && time < measurementEnd) completionsInWindow += 1;
          server.job = null;
          server.finish = Infinity;
          server.remaining = 0;
        }
      });

      if (hasClosure && Math.abs(time - closureStart) < 1e-9) {
        for (let i = scenario.berths - scenario.closureBerths; i < scenario.berths; i += 1) {
          const server = servers[i];
          if (server.job && !server.paused) {
            server.remaining = Math.max(0, server.finish - time);
            server.finish = Infinity;
            server.paused = true;
          }
        }
      }
      if (hasClosure && Math.abs(time - closureEnd) < 1e-9) {
        for (let i = scenario.berths - scenario.closureBerths; i < scenario.berths; i += 1) {
          const server = servers[i];
          if (server.job && server.paused) {
            server.finish = time + server.remaining;
            server.remaining = 0;
            server.paused = false;
          }
        }
      }

      if (nextArrival <= time + 1e-9 && arrivalIndex < arrivals.length) {
        const measured = time >= measurementStart && time < measurementEnd;
        if (measured) arrivalsInWindow += 1;
        queue.push({ arrival: time, measured });
        if (measured) maximumQueue = Math.max(maximumQueue, queue.length);
        arrivalIndex += 1;
      }
      dispatch(time);
      if (time >= measurementStart && time < measurementEnd) maximumQueue = Math.max(maximumQueue, queue.length);
    }

    const averageWaitHours = waits.length ? waits.reduce((sum, value) => sum + value, 0) / waits.length : 0;
    const sortedWaits = waits.slice().sort((a, b) => a - b);
    const p95WaitHours = sortedWaits.length ? sortedWaits[Math.min(sortedWaits.length - 1, Math.ceil(sortedWaits.length * 0.95) - 1)] : 0;
    return {
      arrivals: arrivalsInWindow,
      averageWaitHours,
      p95WaitHours,
      averageQueue: queueArea / scenario.horizonHours,
      maximumQueue,
      utilizationPercent: openBerthHours ? (busyBerthHours / openBerthHours) * 100 : 0,
      completionsPerDay: (completionsInWindow / scenario.horizonHours) * 24,
      servedArrivalCount: waits.length,
      openBerthHours,
      busyBerthHours
    };
  }

  function summarize(values) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sorted = values.slice().sort((a, b) => a - b);
    return {
      mean,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
      p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
    };
  }

  function runReplications(input, seed, replicationCount) {
    const scenario = normalizeScenario(input);
    const baseSeed = Math.trunc(finite(seed === undefined ? 2026 : seed, 'Seed')) >>> 0;
    const count = Math.trunc(finite(replicationCount === undefined ? DEFAULT_REPLICATIONS : replicationCount, 'Replication count'));
    if (count < 1 || count > 100) throw new RangeError('Replication count must be between 1 and 100.');
    const runs = Array.from({ length: count }, (_, i) => oneReplication(scenario, (baseSeed + i * 104729) >>> 0));
    const fields = ['arrivals', 'averageWaitHours', 'p95WaitHours', 'averageQueue', 'maximumQueue', 'utilizationPercent', 'completionsPerDay', 'servedArrivalCount'];
    const metrics = {};
    fields.forEach(field => { metrics[field] = summarize(runs.map(run => run[field])); });
    return {
      scenario,
      seed: baseSeed,
      replications: count,
      warmupHours: WARMUP_HOURS,
      metrics
    };
  }

  return { BASELINE, WARMUP_HOURS, DEFAULT_REPLICATIONS, normalizeScenario, runReplications };
});
