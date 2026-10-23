# Port of Los Angeles Digital Twin

Published site: <https://port-la-phase1-twin.tammineedisriramkart.chatgpt.site/>

This is a static, browser-based geographic twin with an interactive Leaflet map, Port terminal registry, public GIS infrastructure layers, a NOAA historical AIS replay, operations analytics, and a separate assumption-driven berth queue simulator. Historical observations, official statistics, derived measures, and simulated values are labeled separately.

## Source layout

- `dist/index.html` contains the map interface and responsive styles.
- `dist/ais-replay.js` validates and renders the six-hour AIS sample.
- `dist/ops-analytics.js` calculates synchronized AIS activity, berth-line proximity, grid density, Port TEU charts, quality notes, and exports.
- `dist/berth-simulation.js` is a deterministic, browser-independent discrete-event queue model.
- `dist/data/` contains preprocessed Port-area GIS, the harbor-window AIS extract, terminal registry, source manifest, and 2024 Port throughput series.
- `tools/validate_phase2_analytics.py` rechecks source-data QA and page integration.
- `tools/test_berth_simulation.cjs` tests reproducibility and queue-model behavior.

## Data and interpretation

The NOAA Marine Cadastre extract contains 31,058 source fixes from 244 MMSIs on 15 July 2024 between 15:00 and 21:00 UTC. It is a historical sample, not live activity or a complete harbor census. Exact source timestamps and missing motion fields are retained. Trajectories use observed positions only and break at gaps over ten minutes.

The existing Port-supplied berth-line file contains 263 line features. Fifty-two features have a numeric berth-range association to one of the seven Port-listed container terminal records. Those lines are not terminal polygons. All seven terminal boundaries remain **INCOMPLETE**. The separate four OpenStreetMap terminal footprint drafts are unverified and do not complete the inventory.

Terminal activity counts AIS reports assigned to the nearest matched berth line within 100 m, using a local equirectangular projection. This is observed proximity; it does not establish a berthing event, terminal arrival, cargo work, or occupancy.

The throughput chart uses official monthly Port of Los Angeles TEU statistics for calendar year 2024. These reported values are separate from the July AIS sample and are never allocated to individual terminals.

Each feature in the infrastructure export retains its source properties and receives a `source_layer_id` and `source_file`. The seven local vector layers are berth lines, OSM terminal footprint drafts, OSM roads, OSM railways, OSM infrastructure, City street centerlines, and City overweight-container corridors. Remote USGS elevation and NOAA bathymetry rasters are not vector exports.

## Simulation model

The scenario workspace is visibly labeled **SIMULATED** and is isolated from the historical dashboard. It does not use AIS or Port throughput as model inputs.

- Arrivals follow a Poisson process at the user-entered rate.
- Vessels use one first-in, first-out queue and parallel berth service resources.
- Service durations are exponential or Erlang-2, with the entered mean adjusted by dividing by the productive-capacity fraction.
- A temporary closure pauses in-progress work on the selected abstract berth resources and blocks new work there until reopening.
- Each run has a 24-hour warm-up. The selected 24–336-hour measurement interval follows it.
- Twenty deterministic replications run for the fixed illustrative baseline and the configured scenario. The seed and input assumptions can be exported.
- Queued work is drained after the arrival window so every in-window arrival can contribute to waiting-time calculations.
- Mean queue is time-weighted. Utilization is active service berth-hours divided by open scheduled berth-hours. Completions/day counts service completions within the measurement interval.
- The baseline uses 0.20 arrivals/hour, four berths, ten-hour exponential service, 85% productive capacity, and no closure. It is a worked example, not a Port operating benchmark.

The model is not calibrated or validated against actual Port berth events. It does not represent vessel classes, tides, weather, labor shifts, crane constraints, terminal-specific rules, or observed arrival schedules. Its results are scenario estimates, not forecasts.

## Exports

- **Activity CSV** and **Activity JSON** include metric, time window, units, filters, calculation method, source URL, and caveats.
- **Observed tracks JSON** contains AIS metadata and exact UTC source timestamps. It retains duplicate source fixes in its observations, deduplicates only the display segments by timestamp, and breaks segments at the documented gap threshold. No positions are interpolated.
- **Infrastructure GeoJSON** combines the seven bundled vector layers in WGS 84 and includes dataset source/verification metadata plus the seven-record terminal registry. It does not fabricate missing terminal polygons.
- **Scenario JSON** records user assumptions, baseline, seed, model method, metric definitions, limitations, and the latest results if a run has completed.

## Coordinate handoff for future 3D work

GeoJSON remains in WGS 84 (`EPSG:4326`) with longitude/latitude coordinate order. For a future meter-based local 3D scene, `EPSG:26945` (NAD83 / California zone 5, metres) is a regional projected-CRS candidate: the EPSG definition covers Los Angeles County, and California's state guidance places Los Angeles County in Zone 5 under NAD83. If a US survey-foot workflow is required, the corresponding State Plane definition is `EPSG:2229`. Choose the exact horizontal datum operation using PROJ for the dataset area and stated accuracy; its CRS-to-CRS interfaces should be used rather than hand-written projection formulas. Preserve original WGS 84 coordinates and record the applied operation. Do not assign vertical coordinates or convert raster depths until a source-specific vertical datum is known. A local scene origin must come from a verified geographic anchor; none is invented here. No USD exporter is included.

References: [EPSG:26945](https://epsg.io/26945), [EPSG:2229](https://epsg.io/2229), [California Geological Survey State Plane guidance](https://www.conservation.ca.gov/cgs/rgm/state-plane-coordinate-system), and [PROJ CRS transformations](https://proj.org/en/stable/usage/transformation.html).

## Run and validate locally

From the repository root:

```sh
python -m http.server 8000 --directory dist
```

Then open `http://localhost:8000/`.

Run the reproducible checks:

```sh
node --check dist/ais-replay.js
node --check dist/ops-analytics.js
node --check dist/berth-simulation.js
node tools/test_berth_simulation.cjs
python tools/validate_phase2_analytics.py
```

The GIS and AIS datasets are bundled for this study window; no nationwide AIS archive is fetched by the frontend.
