PORT OF LOS ANGELES PHASE 1 MAP DATA

See dataset-manifest.json for per-layer counts, authoritative source links, capture dates, spatial extent, quality status, and caveats.

Integrated datasets (snapshot 2026-10-15)
- Port-supplied berth linework via LA City Open Data: 263 line features and 261 distinct berth labels; source page reports last update 2024-04-24. It is not terminal boundary geometry.
- City of Los Angeles BOE street centerlines: 4,516 features intersecting [-118.34,33.70,-118.13,33.82]. Catalog item last modified 2020-06-26. Raw status values are retained. This is official right-of-way mapping, not proof of current travel access.
- City of Los Angeles BOE overweight container corridor: 332 designated route segments. It is a specialized truck corridor layer, not a complete road network or live route advisory.
- OSM: 4 draft terminal footprint polygons (3 named, 1 unnamed), 5,112 road features, 707 railway features and 629 infrastructure features; captured 2026-10-14. These remain community-mapped and are not Port-verified.
- Port of Los Angeles directory lists 7 major container terminals. It is used as an operator/berth-range reference; official terminal boundary polygons were not available in the sources integrated here.
- No Port-certified dock/quay polygon layer was identified in the integrated public sources. Port berth lines and OSM draft quay features remain visibly distinguished.

- Container terminal registry: 7 Port-listed facilities, with terminal-page attributes and links. Existing berth-line records are associated by their numeric labels only where the Port directory and detail page ranges agree: 52 matched line features / 52 labels. Port-source conflicts (TraPac 134–147 vs 136–147; WBCT China 100–102 vs 100–103) remain visible; disputed labels are not treated as verified matches.
- Terminal boundaries: all 7 registry entries show INCOMPLETE. No Port-certified terminal polygon was integrated. The existing 4 OSM footprint drafts are not assigned to registry records.

Geometry QA
The bundled GeoJSON was checked for parse validity, non-empty geometries, finite longitude/latitude coordinates, expected Los Angeles harbor coordinate range, and feature counts. These checks do not establish surveyed positional accuracy or Port certification.

Remote services
- USGS 3DEP ImageServer: https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer
- NOAA BAG bathymetry ImageServer: https://gis.ngdc.noaa.gov/arcgis/rest/services/bag_bathymetry/ImageServer
- NOAA BAG survey coverage: https://gis.ngdc.noaa.gov/arcgis/rest/services/web_mercator/nos_hydro_dynamic/MapServer/0
These are remote image/coverage services, not local snapshots. The app does not yet surface selected raster acquisition dates, resolution, depth units, or vertical datum. Do not treat them as engineering-grade or navigation products.

Public berth export cleanup
An internal engineering drawing network-path field was removed from the public berth GeoJSON.

Terminal registry details, matched berth labels, published facility attributes, range discrepancies, and source links are in container-terminal-registry.json. A number-range association does not constitute a surveyed terminal boundary.

Historical AIS replay
- NOAA Marine Cadastre 2024 daily AIS broadcast point GeoParquet; source file for 2024-07-15 is 294 MiB nationally and was processed locally with DuckDB. The nationwide source file is not included in the frontend.
- Only the 2024-07-15 15:00:00Z through 21:00:00Z time window and WGS 84 bounding rectangle [-118.38, 33.66, -118.12, 33.80] are served: 31,058 observed positions / 244 MMSIs in a 1.73 MB JSON bundle. The rectangle is a study filter, not a Port-certified harbor boundary.
- Source points preserve MMSI, exact UTC BaseDateTime (stored as Unix UTC seconds), WGS 84 coordinates, SOG, COG and heading where present. NOAA describes the product as downsampled to the nearest whole minute; 30,328 of the 31,058 sampled timestamps retain nonzero seconds. Playback groups by minute bin and point details retain the exact source timestamp. The bundle also holds first available vessel metadata for this window: vessel name, IMO, call sign, type/status codes, dimensions, draft, cargo and transceiver class. Missing values remain null.
- QA on the filtered sample: 31,058 records and 244 MMSIs; all timestamps fall inside the selected six-hour window, all coordinates fall within the published clip rectangle and WGS 84 ranges, all MMSIs are 9-digit values, and present SOG/COG/heading values are in range. Nulls are preserved: 93 SOG, 3,844 COG and 13,608 heading values are missing. There are 7 duplicate MMSI/timestamp rows and 219 >10-minute trajectory gaps; all source positions remain available in the replay, while trajectory rendering uses one deterministic point per duplicate timestamp and breaks at the gaps (maximum observed gap: 4 h 00 m 19 s).
- Trajectories connect observed points only and split where consecutive timestamps are more than 10 minutes apart. No vessel locations are interpolated. Playback shows observations in the selected minute bin only; minutes without reports show no locations.
- Rebuild with tools/build_noaa_ais_clip.py (Python + DuckDB). The builder downloads one source day into a temporary file, clips locally, and writes only the configured harbor window.
- Product docs: https://github.com/ocm-marinecadastre/ais-vessel-traffic/blob/main/data/ais-broadcast-points-2024-readme.md. NOAA citation: Martin, Daniel R., Jesse Brass, Matthew Dornback, and Jeremy Fontenault. 2025. Nationwide Automatic Identification System 2024. NOAA Office for Coastal Management. CC0 1.0.

Phase 2 operations analytics
- The dashboard consumes the existing NOAA AIS JSON bundle used by playback. Minute metrics and hour charts use the same replay cursor and selected MMSI. All windows are UTC and half-open; speed distributions omit null SOG values and use fixed knot bands.
- Spatial density counts observed AIS source fixes in a 0.005 degree WGS 84 grid for the selected hour. It is a report-density overlay, not a unique-vessel count, berth occupancy, live activity, or a complete harbor census.
- Terminal proximity uses only the 52 existing terminal-associated Port-supplied berth-line features (95 line segments in this snapshot). Each AIS fix is assigned at most once, to its nearest line, if the local projected point-to-segment distance is at most 100 m. The result is observed proximity only; no actual berth event is verified. Terminal boundaries remain incomplete.
- Port throughput source: https://portoflosangeles.org/business/statistics/container-statistics/historical-teu-statistics-2024. The dashboard includes the official calendar-year 2024 monthly loaded-import, loaded-export, and total TEU values, retrieved 2026-10-15. This separate monthly series is not joined to or used to infer activity in the July 15 six-hour AIS sample.
- CSV export includes source windows, reporting periods, units, filters, methods, notes, and source URLs. There is no live AIS or operations feed.

Validation
- Run python tools/validate_phase2_analytics.py from the source checkout to recheck AIS schema/time/coordinate bounds, quality counts, terminal-line joins and point-to-segment proximity, Port annual TEU totals, and operations UI integration.

Scenario workspace and interoperable exports
- The berth congestion workspace is explicitly marked SIMULATED and does not consume AIS observations or Port TEU statistics as model inputs.
- Its event model uses Poisson arrivals, a FIFO queue, user-selected exponential or Erlang-2 service, a capacity factor, abstract berth resources, and a temporary closure. It uses a 24-hour warm-up and 20 seeded replications for each case. The fixed comparison baseline is an illustrative example, not a Port operating benchmark.
- See the repository README.md for metric definitions, model assumptions, limitations, local validation commands, and a future 3D coordinate handoff note.
- New exports: an activity JSON counterpart to the existing CSV; observed AIS trajectory JSON with exact source UTC seconds and gap breaks; a combined GeoJSON export of the seven local vector datasets and terminal registry; and a SIMULATED scenario configuration JSON.
- The geographic export preserves per-feature source and verification properties. It includes 263 berth-line features and does not add terminal boundary polygons. Remote USGS/NOAA rasters are not exported as vectors.
- The scenario output is not calibrated or validated against Port operational records. No live AIS, berth events, or terminal-level throughput are available in this build.
