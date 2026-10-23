#!/usr/bin/env python3
"""Validate the Phase 2 AIS, berth-proximity, throughput, and page integration data."""
from __future__ import annotations

import collections
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "dist" / "data"
AIS = json.loads((DATA / "ais-history-2024-07-15.json").read_text())
BERTHS = json.loads((DATA / "port-berths.geojson").read_text())
REGISTRY = json.loads((DATA / "container-terminal-registry.json").read_text())
TEU = json.loads((DATA / "container-throughput-2024.json").read_text())
MANIFEST = json.loads((DATA / "dataset-manifest.json").read_text())

def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)

positions = AIS["positions"]
vessels = AIS["vessels"]
require(len(positions) == 31_058, "AIS source-fix count changed")
require(len(vessels) == 244, "AIS MMSI count changed")
require(AIS["period_start_utc"] == "2024-07-15T15:00:00Z", "Unexpected AIS start")
require(AIS["period_end_exclusive_utc"] == "2024-07-15T21:00:00Z", "Unexpected AIS end")

start = int(__import__("datetime").datetime.fromisoformat(AIS["period_start_utc"].replace("Z", "+00:00")).timestamp())
end = int(__import__("datetime").datetime.fromisoformat(AIS["period_end_exclusive_utc"].replace("Z", "+00:00")).timestamp())
min_lon, min_lat, max_lon, max_lat = AIS["bbox_wgs84"]
missing = collections.Counter()
timestamps = collections.defaultdict(set)
duplicate_rows = collections.Counter()
for vessel_index, timestamp, lon, lat, sog, cog, heading in positions:
    require(0 <= vessel_index < len(vessels), "AIS row points to a missing vessel")
    require(start <= timestamp < end, "AIS timestamp outside the selected UTC interval")
    require(min_lon <= lon <= max_lon and min_lat <= lat <= max_lat, "AIS point outside clip bounds")
    require(-180 <= lon <= 180 and -90 <= lat <= 90, "Invalid WGS 84 coordinate")
    require(sog is None or 0 <= sog <= 102.2, "SOG outside accepted range")
    require(cog is None or 0 <= cog < 360, "COG outside accepted range")
    require(heading is None or 0 <= heading <= 359, "Heading outside accepted range")
    missing["SOG"] += sog is None
    missing["COG"] += cog is None
    missing["heading"] += heading is None
    timestamps[vessel_index].add(timestamp)
    duplicate_rows[(vessel_index, timestamp)] += 1
extra_duplicate_rows = sum(count - 1 for count in duplicate_rows.values() if count > 1)
long_gaps = []
for time_set in timestamps.values():
    ordered = sorted(time_set)
    long_gaps.extend(b - a for a, b in zip(ordered, ordered[1:]) if b - a > 600)
require(dict(missing) == {"SOG": 93, "COG": 3844, "heading": 13608}, "AIS missing-field counts changed")
require(extra_duplicate_rows == 7, "AIS duplicate-row count changed")
require(len(long_gaps) == 219 and max(long_gaps) == 14_419, "AIS >10-minute gap metrics changed")

terminals = REGISTRY["terminals"]
terminal_ids = {terminal["id"] for terminal in terminals}
matched = [feature for feature in BERTHS["features"] if feature.get("properties", {}).get("terminal_id")]
matched_ids = {feature["properties"]["terminal_id"] for feature in matched}
require(len(terminals) == 7, "Terminal registry must retain seven official records")
require(len(matched) == 52, "Matched berth-line feature count changed")
require(matched_ids == terminal_ids, "One or more terminal records have no existing matched berth line")
require(all(feature["geometry"]["type"] in ("LineString", "MultiLineString") for feature in matched),
        "A matched berth feature is not line geometry")

# Reproduce the browser's local equirectangular point-to-segment calculation.
radius = 6_371_008.8
deg = math.pi / 180
origin_lat = 33.73
origin_lon = -118.26
cos_lat = math.cos(origin_lat * deg)
def project(lon, lat):
    return (radius * cos_lat * ((lon - origin_lon) * deg),
            radius * ((lat - origin_lat) * deg))
segments = []
for feature in matched:
    props = feature["properties"]
    geometry = feature["geometry"]
    paths = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
    for path in paths:
        for first, second in zip(path, path[1:]):
            segments.append((project(first[0], first[1]), project(second[0], second[1]), props["terminal_id"]))
require(len(segments) > 0, "No matched berth-line segments available")
proximity_counts = collections.Counter()
for vessel_index, timestamp, lon, lat, *_ in positions:
    point = project(lon, lat)
    best_distance = math.inf
    best_terminal = None
    for a, b, terminal_id in segments:
        dx, dy = b[0] - a[0], b[1] - a[1]
        length2 = dx * dx + dy * dy
        factor = 0 if not length2 else max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2))
        distance = math.hypot(point[0] - (a[0] + factor * dx), point[1] - (a[1] + factor * dy))
        if distance <= 100 and distance < best_distance:
            best_distance, best_terminal = distance, terminal_id
    if best_terminal:
        proximity_counts[best_terminal] += 1
require(sum(proximity_counts.values()) <= len(positions), "Proximity assignment duplicated AIS fixes")
require(set(proximity_counts).issubset(terminal_ids), "Proximity assigned to an unknown terminal")

monthly = TEU["monthly"]
require(len(monthly) == 12, "2024 throughput archive must include twelve months")
require(len({row["month"] for row in monthly}) == 12, "Duplicate monthly throughput period")
for row in monthly:
    require(row["total_teus"] > 0 and row["loaded_imports_teu"] >= 0 and row["loaded_exports_teu"] >= 0,
            "Invalid Port throughput count")
annual = sum(row["total_teus"] for row in monthly)
require(abs(annual - 10_297_352.25) < 0.01, "Monthly TEUs do not match Port's calendar-year total")
require(TEU["source_url"].endswith("historical-teu-statistics-2024"), "Throughput source is not the official 2024 archive")

geojson_layer_counts = {}
for dataset in MANIFEST["datasets"]:
    filename = dataset.get("file", "")
    if not filename.endswith(".geojson"):
        continue
    layer = json.loads((DATA / filename).read_text())
    require(layer.get("type") == "FeatureCollection" and isinstance(layer.get("features"), list),
            "Invalid geographic dataset: " + filename)
    require(len(layer["features"]) == dataset.get("feature_count"),
            "Feature count does not match the source manifest: " + filename)
    geojson_layer_counts[dataset["id"]] = len(layer["features"])
require(len(geojson_layer_counts) == 7, "Expected all seven local vector infrastructure datasets")

page = (ROOT / "dist" / "index.html").read_text()
replay = (ROOT / "dist" / "ais-replay.js").read_text()
simulator = (ROOT / "dist" / "berth-simulation.js").read_text()
for element_id in ("opsDashboard", "opsMetricFixes", "opsMetricVessels", "opsHourlyChart", "opsSpeedChart",
                   "opsDensityToggle", "opsTerminalList", "opsThroughputChart", "opsQuality", "opsExport",
                   "opsExportActivityJson", "opsExportTracks", "opsExportGeoJson", "simulationWorkspace",
                   "simArrivalRate", "simBerths", "simServiceHours", "simClosureBerths", "simRun", "simExportConfig"):
    require('id="' + element_id + '"' in page, "Missing operations UI control: " + element_id)
require('src="ops-analytics.js"' in page and 'src="ais-replay.js"' in page and 'src="berth-simulation.js"' in page,
        "Analytics, replay, or simulator scripts not loaded")
require("trajectoryLayer = L.featureGroup()" in replay, "Selected vessel trajectory collection must support bounds and selection")
require("classification: 'SIMULATED'" in (ROOT / "dist" / "ops-analytics.js").read_text(),
        "Scenario exports must be prominently classified as simulated")
require("source_data_used: false" in (ROOT / "dist" / "ops-analytics.js").read_text(),
        "Scenario exports must identify that operational source data is not used")
require("gap_break_threshold_seconds" in (ROOT / "dist" / "ops-analytics.js").read_text(),
        "Trajectory exports must document their observed-fix gap threshold")
ids = re.findall(r'\bid="([^"]+)"', page)
require(len(ids) == len(set(ids)), "Duplicate HTML IDs detected")

print(json.dumps({
    "ais": {"fixes": len(positions), "mmsis": len(vessels), "missing_motion_fields": dict(missing),
            "duplicate_extra_rows": extra_duplicate_rows, "gaps_over_10m": len(long_gaps),
            "maximum_gap_seconds": max(long_gaps)},
    "berths": {"matched_features": len(matched), "line_segments": len(segments),
               "terminal_ids": len(terminal_ids), "proximity_fixes_within_100m": sum(proximity_counts.values()),
               "proximity_by_terminal": dict(proximity_counts)},
    "throughput": {"months": len(monthly), "annual_total_teus": round(annual, 2),
                   "source": TEU["source_url"], "retrieved_on": TEU["retrieved_on"]},
    "geographic_export": {"local_vector_layers": len(geojson_layer_counts),
                          "source_feature_count": sum(geojson_layer_counts.values()),
                          "layer_feature_counts": geojson_layer_counts},
    "page": {"operations_controls_present": True, "unique_html_ids": len(ids),
             "simulation_workspace_present": True, "export_formats": ["CSV", "JSON", "GeoJSON"]}
}, indent=2))
