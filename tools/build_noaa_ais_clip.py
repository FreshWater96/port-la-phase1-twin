#!/usr/bin/env python3
"""Build the static, harbor-clipped historical AIS bundle used by the map.

Requires Python 3.10+ and DuckDB (`python -m pip install duckdb`). The script
downloads one NOAA daily GeoParquet source to a temporary file, clips it locally
to the documented rectangle and six-hour UTC window, writes only those records,
and deletes the nationwide source file when finished.
"""

from __future__ import annotations

import argparse
import json
import math
import tempfile
import urllib.request
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path

import duckdb


SOURCE_TEMPLATE = (
    "https://ocmgeodatastor1.blob.core.windows.net/marinecadastre/ais2024/"
    "ais-{date}.parquet"
)
SOURCE_REPOSITORY = "https://github.com/ocm-marinecadastre/ais-vessel-traffic"
SOURCE_README = (
    "https://github.com/ocm-marinecadastre/ais-vessel-traffic/blob/main/"
    "data/ais-broadcast-points-2024-readme.md"
)
DEFAULT_DATE = "2024-07-15"
DEFAULT_START_UTC = "15:00:00"
DEFAULT_END_UTC = "21:00:00"
# This is a rectangular study filter window, not an official Port boundary.
BBOX = (-118.38, 33.66, -118.12, 33.80)
GAP_BREAK_MINUTES = 10


def utc_iso(dt: datetime) -> str:
    return dt.replace(tzinfo=timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def value_or_none(value):
    if value is None:
        return None
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return round(value, 6)
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=DEFAULT_DATE)
    parser.add_argument("--output", default="dist/data/ais-history-2024-07-15.json")
    parser.add_argument("--source-file", help="Use an already-downloaded source file")
    args = parser.parse_args()

    date = datetime.strptime(args.date, "%Y-%m-%d").date()
    start = datetime.fromisoformat(f"{args.date}T{DEFAULT_START_UTC}").replace(
        tzinfo=timezone.utc
    )
    end = datetime.fromisoformat(f"{args.date}T{DEFAULT_END_UTC}").replace(
        tzinfo=timezone.utc
    )
    source_url = SOURCE_TEMPLATE.format(date=date.isoformat())

    temporary_source = (
        tempfile.NamedTemporaryFile(prefix="noaa-ais-", suffix=".parquet")
        if not args.source_file
        else nullcontext(None)
    )
    with temporary_source as raw:
        if raw:
            request = urllib.request.Request(
                source_url,
                headers={"User-Agent": "PortLA-DigitalTwin-AIS-clip/1.0"},
            )
            with urllib.request.urlopen(request, timeout=180) as response:
                while chunk := response.read(1024 * 1024):
                    raw.write(chunk)
            raw.flush()
            source_path = raw.name
        else:
            source_path = args.source_file

        connection = duckdb.connect()
        try:
            try:
                connection.execute("LOAD spatial")
            except duckdb.Error:
                connection.execute("INSTALL spatial")
                connection.execute("LOAD spatial")

            path = str(source_path).replace("'", "''")
            connection.execute(
                f"""
                CREATE TEMP VIEW source_points AS
                SELECT *, ST_X(geometry) AS lon, ST_Y(geometry) AS lat
                FROM read_parquet('{path}')
                """
            )
            raw_quality = connection.execute(
                """
                SELECT
                  count(*) AS source_rows,
                  count(*) FILTER (WHERE lon IS NULL OR lat IS NULL OR
                    NOT isfinite(lon) OR NOT isfinite(lat) OR
                    lon NOT BETWEEN -180 AND 180 OR lat NOT BETWEEN -90 AND 90)
                    AS invalid_coordinate_rows,
                  count(*) FILTER (WHERE mmsi IS NULL OR base_date_time IS NULL)
                    AS missing_identifier_or_time_rows
                FROM source_points
                """
            ).fetchone()
            where = """
                lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?
                AND base_date_time >= ? AND base_date_time < ?
                AND mmsi IS NOT NULL AND base_date_time IS NOT NULL
                AND isfinite(lon) AND isfinite(lat)
                AND lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90
            """
            min_lon, min_lat, max_lon, max_lat = BBOX
            params = [min_lon, max_lon, min_lat, max_lat, start.replace(tzinfo=None), end.replace(tzinfo=None)]
            vessel_rows = connection.execute(
                f"""
                SELECT mmsi,
                  arg_min(nullif(trim(vessel_name), ''), base_date_time) AS vessel_name,
                  arg_min(nullif(trim(imo), ''), base_date_time) AS imo,
                  arg_min(nullif(trim(call_sign), ''), base_date_time) AS call_sign,
                  arg_min(vessel_type, base_date_time) AS vessel_type,
                  arg_min(status, base_date_time) AS status,
                  arg_min(length, base_date_time) AS length_m,
                  arg_min(width, base_date_time) AS width_m,
                  arg_min(draft, base_date_time) AS draft_m,
                  arg_min(cargo, base_date_time) AS cargo,
                  arg_min(nullif(trim(transceiver), ''), base_date_time) AS transceiver_class,
                  min(base_date_time) AS first_seen,
                  max(base_date_time) AS last_seen,
                  count(*) AS position_count
                FROM source_points
                WHERE {where}
                GROUP BY mmsi
                ORDER BY mmsi
                """,
                params,
            ).fetchall()
            event_rows = connection.execute(
                f"""
                SELECT mmsi, base_date_time, lon, lat, sog, cog, heading
                FROM source_points
                WHERE {where}
                ORDER BY base_date_time, mmsi, lon, lat
                """,
                params,
            ).fetchall()
            duplicate_rows = connection.execute(
                f"""
                SELECT count(*) - count(DISTINCT (mmsi, base_date_time))
                FROM source_points WHERE {where}
                """,
                params,
            ).fetchone()[0]
            sample_quality = connection.execute(
                f"""
                SELECT
                  count(*) AS position_count,
                  count(DISTINCT mmsi) AS vessel_count,
                  count(*) FILTER (WHERE mmsi NOT BETWEEN 100000000 AND 999999999)
                    AS invalid_mmsi_rows,
                  count(*) FILTER (WHERE sog IS NOT NULL AND
                    (NOT isfinite(sog) OR sog < 0 OR sog > 102.2)) AS invalid_sog_rows,
                  count(*) FILTER (WHERE cog IS NOT NULL AND
                    (NOT isfinite(cog) OR cog < 0 OR cog >= 360)) AS invalid_cog_rows,
                  count(*) FILTER (WHERE heading IS NOT NULL AND
                    (heading < 0 OR heading > 359)) AS invalid_heading_rows,
                  count(*) FILTER (WHERE sog IS NULL) AS null_sog_rows,
                  count(*) FILTER (WHERE cog IS NULL) AS null_cog_rows,
                  count(*) FILTER (WHERE heading IS NULL) AS null_heading_rows,
                  count(*) FILTER (WHERE extract(second FROM base_date_time) <> 0)
                    AS timestamp_rows_with_nonzero_seconds
                FROM source_points WHERE {where}
                """,
                params,
            ).fetchone()
            connection.close()
        except Exception:
            connection.close()
            raise

    if any(sample_quality[index] for index in range(2, 6)):
        raise ValueError(f"AIS sample contains invalid identifiers or motion values: {sample_quality}")

    vessel_index = {row[0]: i for i, row in enumerate(vessel_rows)}
    vessels = []
    for row in vessel_rows:
        (
            mmsi,
            name,
            imo,
            call_sign,
            vessel_type,
            status,
            length_m,
            width_m,
            draft_m,
            cargo,
            transceiver,
            first_seen,
            last_seen,
            position_count,
        ) = row
        vessels.append(
            {
                "mmsi": int(mmsi),
                "name": name,
                "imo": imo,
                "call_sign": call_sign,
                "vessel_type": value_or_none(vessel_type),
                "status": value_or_none(status),
                "length_m": value_or_none(length_m),
                "width_m": value_or_none(width_m),
                "draft_m": value_or_none(draft_m),
                "cargo": value_or_none(cargo),
                "transceiver_class": transceiver,
                "first_seen_utc": utc_iso(first_seen),
                "last_seen_utc": utc_iso(last_seen),
                "position_count": int(position_count),
            }
        )

    positions = []
    for mmsi, timestamp, lon, lat, sog, cog, heading in event_rows:
        positions.append(
            [
                vessel_index[mmsi],
                int(timestamp.replace(tzinfo=timezone.utc).timestamp()),
                value_or_none(lon),
                value_or_none(lat),
                value_or_none(sog),
                value_or_none(cog),
                value_or_none(heading),
            ]
        )

    payload = {
        "dataset": "NOAA Marine Cadastre AIS broadcast point data for U.S. waters 2024",
        "source_url": source_url,
        "source_repository": SOURCE_REPOSITORY,
        "source_readme": SOURCE_README,
        "citation": "Martin, Daniel R., Jesse Brass, Matthew Dornback, and Jeremy Fontenault. 2025. Nationwide Automatic Identification System 2024. NOAA Office for Coastal Management.",
        "license": "CC0 1.0 Universal",
        "crs": "EPSG:4326 / WGS 84",
        "timestamp_semantics": "BaseDateTime is the exact source timestamp in UTC seconds. NOAA describes the product as downsampled to the nearest whole minute; playback groups records into minute bins while point details preserve the exact source time.",
        "period_start_utc": utc_iso(start),
        "period_end_exclusive_utc": utc_iso(end),
        "bbox_wgs84": list(BBOX),
        "bbox_note": "Rectangular study-window filter only; not a Port-certified or legal harbor boundary.",
        "gap_break_minutes": GAP_BREAK_MINUTES,
        "duplicate_mmsi_timestamp_rows": int(duplicate_rows),
        "source_row_count": int(raw_quality[0]),
        "source_invalid_coordinate_rows": int(raw_quality[1]),
        "source_missing_identifier_or_time_rows": int(raw_quality[2]),
        "position_count": len(positions),
        "vessel_count": len(vessels),
        "sample_quality": {
            "invalid_mmsi_rows": int(sample_quality[2]),
            "invalid_sog_rows": int(sample_quality[3]),
            "invalid_cog_rows": int(sample_quality[4]),
            "invalid_heading_rows": int(sample_quality[5]),
            "null_sog_rows": int(sample_quality[6]),
            "null_cog_rows": int(sample_quality[7]),
            "null_heading_rows": int(sample_quality[8]),
            "timestamps_with_nonzero_seconds": int(sample_quality[9]),
        },
        "position_encoding": "[vessel_index, Unix_UTC_seconds, longitude, latitude, SOG_knots, COG_degrees, heading_degrees]; unavailable values are null.",
        "vessels": vessels,
        "positions": positions,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(output),
                "bytes": output.stat().st_size,
                "positions": len(positions),
                "vessels": len(vessels),
                "duplicate_mmsi_timestamp_rows": int(duplicate_rows),
                "source_row_count": int(raw_quality[0]),
                "invalid_source_coordinates": int(raw_quality[1]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
