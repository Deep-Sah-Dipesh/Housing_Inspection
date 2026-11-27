"""
Incremental dataset updation & validation tool for Housing Inspection.

Usage:
  python databases_and_scripts/update_dataset.py
  python databases_and_scripts/update_dataset.py --yes
  python databases_and_scripts/update_dataset.py --dry-run
  python databases_and_scripts/update_dataset.py --reprocess-all

What it does:
  1. Checks `databases_and_scripts/processed/processed_manifest.json` to find any
     Excel/CSV files in `databases_and_scripts/` (or `dataset/`) that have not been
     processed yet or were modified since the last run.
  2. Parses unprocessed files, validates records, and flags potential mistakes/warnings
     (missing ID/name/district/city, conflicting names/locations, skipped sheets, etc.).
  3. Prints a clear change summary & review report before applying changes.
  4. Saves artifacts into `databases_and_scripts/processed/`:
       - `beneficiaries_seed_previous.json` (latest-1 / previous seed JSON)
       - `beneficiaries_seed_<YYYYMMDD_HHMMSS>.json` (latest seed JSON)
       - `housing_inspection_<YYYYMMDD_HHMMSS>.db` (latest SQLite DB)
       - `updation_log_<YYYYMMDD_HHMMSS>.log` (audit log of changes & warnings)
       - `processed_manifest.json` (SHA-256 registry of processed Excel/CSV files)
  5. Updates `assets/beneficiaries_seed.json` so the app & EAS OTA updates ship the new data.
"""

from __future__ import annotations

import argparse
import hashlib
from difflib import SequenceMatcher
import json
import re
import shutil
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
DATASET_DIR = REPO_ROOT / "dataset"
PROCESSED_DIR = SCRIPTS_DIR / "processed"
MANIFEST_PATH = PROCESSED_DIR / "processed_manifest.json"
PREVIOUS_SEED_PATH = PROCESSED_DIR / "beneficiaries_seed_previous.json"
ASSETS_DIR = REPO_ROOT / "assets"
SEED_LOADER_PATH = REPO_ROOT / "utils" / "seedLoader.ts"

SCHEMA_FIELDS = [
    "code",
    "name",
    "serial_number",
    "mobile_number",
    "aadhar_number",
    "bank_name",
    "account_number",
    "district_name",
    "city_name",
    "annexure_id",
    "father_name",
    "project_name",
    "site_address",
]

COLUMN_ALIASES: dict[str, list[str]] = {
    "code": [
        "beneficiaryid",
        "beneficiary_id",
        "application_no",
        "applicationno",
        "application_id",
        "applicationid",
        "application_number",
        "applicationnumber",
        "code",
    ],
    "name": ["beneficiaryname", "beneficiary_name", "fullnameinenglish", "name"],
    "serial_number": ["srno", "sr_no", "s_no", "sno", "serial_number", "serialnumber"],
    "mobile_number": ["mobile_no", "mobileno", "mobilenumber", "mobile_number", "mobile"],
    "aadhar_number": ["aadhaarnumber", "aadhaar_number", "aadharnumber", "aadhar_number", "adharcardnumber"],
    "bank_name": ["bankname", "bank_name"],
    "account_number": ["accountnumber", "account_number", "account_no", "accountno"],
    "district_name": ["district_name", "districtname", "district"],
    "city_name": ["city_name", "cityname", "ulbname", "ulb_name", "city", "ulb", "town"],
    "annexure_id": ["annexure_id", "annexureid", "annexure"],
    "father_name": ["beneficiaryfathername", "father_name", "fathername", "fathers_name"],
    "project_name": ["projectname", "project_name", "project"],
    "site_address": ["constructionsiteaddress", "property_address", "site_address", "siteaddress", "address"],
}

CODE_ALIAS_SET = {re.sub(r"[^a-z0-9]+", "", a.lower()) for a in COLUMN_ALIASES["code"]}


@dataclass
class FileParseReport:
    rel_path: str
    file_hash: str
    file_size: int
    mtime_iso: str
    sheets_processed: list[str] = field(default_factory=list)
    sheets_skipped: list[str] = field(default_factory=list)
    rows_extracted: int = 0
    rows_missing_code: int = 0
    warnings: list[str] = field(default_factory=list)
    records: list[dict[str, str]] = field(default_factory=list)


@dataclass
class MergeDiff:
    previous_count: int
    final_count: int
    added_records: list[dict[str, str]] = field(default_factory=list)
    enriched_records: list[dict[str, Any]] = field(default_factory=list)
    unchanged_duplicates: int = 0
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    quality_warnings: list[str] = field(default_factory=list)


def normalize_col_name(col: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(col).strip().lower())


def clean_value(val: Any) -> str:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    text = str(val).strip()
    if text.lower() in {"nan", "none", "null", "nat"}:
        return ""
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def serial_sort_key(serial: str) -> tuple[int, str]:
    digits = re.sub(r"[^0-9]", "", serial)
    return (int(digits) if digits else -1, serial)


def compute_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_city_name(city: str) -> str:
    """Remove irrelevant comma/slash/semicolon separators from city/ULB names."""
    if not city:
        return ""
    cleaned = re.sub(r"[,/;]+", " ", city)
    return re.sub(r"\s+", " ", cleaned).strip()


def infer_location_from_address(address: str) -> tuple[str, str]:
    """Infer (city_name, district_name) from standard PMAY address suffixes when columns are absent."""
    match = re.search(
        r"([A-Za-z]+,?\s*Municipality)\s+([A-Za-z]+)\s+Gujarat\b",
        address,
        re.IGNORECASE,
    )
    if match:
        city = clean_city_name(match.group(1)).title()
        district = match.group(2).strip().title()
        return city, district
    return "", ""


def detect_header_row(raw_df: pd.DataFrame, max_scan: int = 12) -> int | None:
    limit = min(max_scan, len(raw_df))
    for idx in range(limit):
        row_norms = {normalize_col_name(v) for v in raw_df.iloc[idx].tolist() if pd.notna(v)}
        if row_norms & CODE_ALIAS_SET:
            return idx
    return None


def map_dataframe(
    df: pd.DataFrame,
    source_label: str,
    default_project: str = "",
) -> tuple[list[dict[str, str]], int, list[str]]:
    normalized_lookup: dict[str, Any] = {}
    for col in df.columns:
        norm = normalize_col_name(col)
        if norm and norm not in normalized_lookup:
            normalized_lookup[norm] = col

    resolved_cols: dict[str, Any] = {}
    for target_field, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            norm_alias = normalize_col_name(alias)
            if norm_alias in normalized_lookup:
                resolved_cols[target_field] = normalized_lookup[norm_alias]
                break

    if "code" not in resolved_cols:
        return [], 0, [f"{source_label}: missing BeneficiaryID / Application ID column."]

    records: list[dict[str, str]] = []
    missing_code_rows = 0
    warnings: list[str] = []

    if "name" not in resolved_cols:
        warnings.append(f"{source_label}: no BeneficiaryName / Name column found.")

    for _, row in df.iterrows():
        raw_values = [clean_value(v) for v in row.tolist()]
        if not any(raw_values):
            continue
        code = clean_value(row[resolved_cols["code"]])
        if not code:
            missing_code_rows += 1
            continue
        if normalize_col_name(code) in CODE_ALIAS_SET:
            continue

        record: dict[str, str] = {"code": code}
        for field_name in SCHEMA_FIELDS[1:]:
            col_name = resolved_cols.get(field_name)
            record[field_name] = clean_value(row[col_name]) if col_name is not None else ""

        if (not record["city_name"] or not record["district_name"]) and record["site_address"]:
            inferred_city, inferred_district = infer_location_from_address(record["site_address"])
            if not record["city_name"] and inferred_city:
                record["city_name"] = inferred_city
            if not record["district_name"] and inferred_district:
                record["district_name"] = inferred_district

        if not record["project_name"] and default_project:
            record["project_name"] = default_project

        record["city_name"] = clean_city_name(record["city_name"])
        if record["city_name"].upper().startswith(("HIMATNAGAR", "HIMMATNAGAR")):
            record["city_name"] = "HIMMATNAGAR MUNICIPALITY"
        if not record["district_name"] and "HIMMATNAGAR" in record["city_name"].upper():
            record["district_name"] = "Sabar Kantha"
        records.append(record)

    return records, missing_code_rows, warnings


def parse_dataset_file(file_path: Path) -> FileParseReport:
    stat = file_path.stat()
    report = FileParseReport(
        rel_path=str(file_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        file_hash=compute_sha256(file_path),
        file_size=stat.st_size,
        mtime_iso=datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    )

    suffix = file_path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        excel_file = pd.ExcelFile(file_path)
        for sheet_name in excel_file.sheet_names:
            if "no seeding" in sheet_name.lower():
                report.sheets_skipped.append(f"{sheet_name} (marked NO SEEDING)")
                continue
            raw_df = excel_file.parse(sheet_name=sheet_name, header=None, dtype=str)
            if raw_df.empty:
                report.sheets_skipped.append(f"{sheet_name} (empty)")
                continue
            header_idx = detect_header_row(raw_df)
            if header_idx is None:
                report.sheets_skipped.append(f"{sheet_name} (no ID header found)")
                report.warnings.append(
                    f"{report.rel_path} [{sheet_name}]: skipped because no BeneficiaryID / Application ID header was found."
                )
                continue

            banner_texts = [
                clean_value(v)
                for r in range(header_idx)
                for v in raw_df.iloc[r].tolist()
                if clean_value(v) and "request done" not in clean_value(v).lower()
            ]
            default_project = banner_texts[0] if banner_texts else file_path.stem

            df = raw_df.iloc[header_idx + 1 :].copy()
            df.columns = [
                clean_value(c) or f"Unnamed_{i}" for i, c in enumerate(raw_df.iloc[header_idx].tolist())
            ]
            df = df.dropna(how="all")
            if df.empty:
                report.sheets_skipped.append(f"{sheet_name} (no data rows)")
                continue

            recs, missing_codes, map_warnings = map_dataframe(
                df, f"{report.rel_path} [{sheet_name}]", default_project=default_project
            )
            report.sheets_processed.append(f"{sheet_name} ({len(recs)} rows)")
            report.rows_extracted += len(recs)
            report.rows_missing_code += missing_codes
            report.warnings.extend(map_warnings)
            if missing_codes > 0:
                report.warnings.append(
                    f"{report.rel_path} [{sheet_name}]: {missing_codes} non-empty row(s) missing Application/Beneficiary ID."
                )
            report.records.extend(recs)

    elif suffix == ".csv":
        raw_df = pd.read_csv(file_path, header=None, dtype=str)
        header_idx = detect_header_row(raw_df)
        if header_idx is None:
            report.sheets_skipped.append("csv (no ID header found)")
            report.warnings.append(f"{report.rel_path}: no BeneficiaryID / Application ID header found.")
        else:
            df = raw_df.iloc[header_idx + 1 :].copy()
            df.columns = [
                clean_value(c) or f"Unnamed_{i}" for i, c in enumerate(raw_df.iloc[header_idx].tolist())
            ]
            df = df.dropna(how="all")
            recs, missing_codes, map_warnings = map_dataframe(df, report.rel_path, default_project=file_path.stem)
            report.sheets_processed.append(f"CSV ({len(recs)} rows)")
            report.rows_extracted += len(recs)
            report.rows_missing_code += missing_codes
            report.warnings.extend(map_warnings)
            if missing_codes > 0:
                report.warnings.append(
                    f"{report.rel_path}: {missing_codes} non-empty row(s) missing Application/Beneficiary ID."
                )
            report.records.extend(recs)

    return report


def merge_and_analyze(
    previous_records: list[dict[str, Any]],
    incoming_reports: list[FileParseReport],
) -> tuple[list[dict[str, str]], MergeDiff]:
    merged: dict[str, dict[str, str]] = {}
    previous_codes: set[str] = set()

    for item in previous_records:
        code = clean_value(item.get("code"))
        if not code:
            continue
        record = {field_name: clean_value(item.get(field_name)) for field_name in SCHEMA_FIELDS}
        record["code"] = code
        record["city_name"] = clean_city_name(record["city_name"])
        merged[code] = record
        previous_codes.add(code)

    diff = MergeDiff(previous_count=len(merged), final_count=len(merged))
    added_map: dict[str, dict[str, str]] = {}
    enriched_map: dict[str, dict[str, Any]] = {}

    missing_name_codes: list[str] = []
    missing_location_codes: list[str] = []
    suspicious_codes: list[str] = []

    for report in incoming_reports:
        for item in report.records:
            code = item["code"]
            if len(code) < 5 or " " in code:
                suspicious_codes.append(f"{code} ({report.rel_path})")
            if not item.get("name"):
                missing_name_codes.append(f"{code} ({report.rel_path})")
            if not item.get("district_name") or not item.get("city_name"):
                missing_location_codes.append(f"{code} ({report.rel_path})")

            if code not in merged:
                merged[code] = dict(item)
                added_map[code] = merged[code]
                continue

            existing = merged[code]
            old_name = existing.get("name", "").strip()
            new_name = item.get("name", "").strip()
            if old_name and new_name and old_name.lower() != new_name.lower():
                diff.conflicts.append(
                    {
                        "code": code,
                        "source": report.rel_path,
                        "field": "name",
                        "existing": old_name,
                        "incoming": new_name,
                    }
                )

            prefer_new = serial_sort_key(item.get("serial_number", "")) >= serial_sort_key(
                existing.get("serial_number", "")
            )
            field_changes: dict[str, tuple[str, str]] = {}
            for field_name in SCHEMA_FIELDS[1:]:
                new_val = item.get(field_name, "")
                old_val = existing.get(field_name, "")
                chosen = (new_val if new_val else old_val) if prefer_new else (old_val if old_val else new_val)
                if chosen != old_val:
                    field_changes[field_name] = (old_val, chosen)
                existing[field_name] = chosen

            if field_changes and code in previous_codes:
                if code not in enriched_map:
                    enriched_map[code] = {"code": code, "name": existing.get("name", ""), "changes": {}}
                enriched_map[code]["changes"].update(field_changes)
            elif not field_changes:
                diff.unchanged_duplicates += 1

    if missing_name_codes:
        diff.quality_warnings.append(
            f"{len(missing_name_codes)} record(s) have an empty Beneficiary Name (e.g. {', '.join(missing_name_codes[:3])})."
        )
    if missing_location_codes:
        diff.quality_warnings.append(
            f"{len(missing_location_codes)} record(s) are missing District or City (e.g. {', '.join(missing_location_codes[:3])})."
        )
    if suspicious_codes:
        diff.quality_warnings.append(
            f"{len(suspicious_codes)} record(s) have unusual Application/Beneficiary IDs (e.g. {', '.join(suspicious_codes[:3])})."
        )

    final_records = sorted(merged.values(), key=lambda r: (r["code"], r["serial_number"]))
    diff.added_records = sorted(added_map.values(), key=lambda r: r["code"])
    diff.enriched_records = list(enriched_map.values())
    diff.final_count = len(final_records)
    return final_records, diff


def ingest_into_sqlite(records: list[dict[str, str]], db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS beneficiaries (
              code TEXT PRIMARY KEY,
              name TEXT,
              serial_number TEXT,
              mobile_number TEXT,
              aadhar_number TEXT,
              bank_name TEXT,
              account_number TEXT,
              amount TEXT,
              district_name TEXT,
              city_name TEXT,
              annexure_id TEXT,
              father_name TEXT,
              project_name TEXT,
              site_address TEXT,
              inspection_status TEXT DEFAULT 'pending',
              sync_status TEXT DEFAULT 'pending',
              is_custom INTEGER DEFAULT 0,
              last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        conn.executemany(
            """
            INSERT INTO beneficiaries (
              code, name, serial_number, mobile_number, aadhar_number,
              bank_name, account_number, district_name, city_name,
              annexure_id, father_name, project_name, site_address,
              inspection_status, sync_status, is_custom
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 0)
            ON CONFLICT(code) DO UPDATE SET
              name = CASE WHEN excluded.name != '' THEN excluded.name ELSE beneficiaries.name END,
              serial_number = CASE WHEN excluded.serial_number != '' THEN excluded.serial_number ELSE beneficiaries.serial_number END,
              mobile_number = CASE WHEN excluded.mobile_number != '' THEN excluded.mobile_number ELSE beneficiaries.mobile_number END,
              aadhar_number = CASE WHEN excluded.aadhar_number != '' THEN excluded.aadhar_number ELSE beneficiaries.aadhar_number END,
              bank_name = CASE WHEN excluded.bank_name != '' THEN excluded.bank_name ELSE beneficiaries.bank_name END,
              account_number = CASE WHEN excluded.account_number != '' THEN excluded.account_number ELSE beneficiaries.account_number END,
              district_name = CASE WHEN excluded.district_name != '' THEN excluded.district_name ELSE beneficiaries.district_name END,
              city_name = CASE WHEN excluded.city_name != '' THEN excluded.city_name ELSE beneficiaries.city_name END,
              annexure_id = CASE WHEN excluded.annexure_id != '' THEN excluded.annexure_id ELSE beneficiaries.annexure_id END,
              father_name = CASE WHEN excluded.father_name != '' THEN excluded.father_name ELSE beneficiaries.father_name END,
              project_name = CASE WHEN excluded.project_name != '' THEN excluded.project_name ELSE beneficiaries.project_name END,
              site_address = CASE WHEN excluded.site_address != '' THEN excluded.site_address ELSE beneficiaries.site_address END;
            """,
            [
                (
                    r["code"],
                    r["name"],
                    r["serial_number"],
                    r["mobile_number"],
                    r["aadhar_number"],
                    r["bank_name"],
                    r["account_number"],
                    r["district_name"],
                    r["city_name"],
                    r["annexure_id"],
                    r["father_name"],
                    r["project_name"],
                    r["site_address"],
                )
                for r in records
            ],
        )
        conn.commit()
    finally:
        conn.close()


def discover_dataset_files() -> list[Path]:
    candidate_dirs = [SCRIPTS_DIR]
    if DATASET_DIR.exists() and DATASET_DIR.is_dir():
        candidate_dirs.append(DATASET_DIR)

    files: list[Path] = []
    for directory in candidate_dirs:
        for file_path in sorted(directory.rglob("*")):
            if PROCESSED_DIR in file_path.parents:
                continue
            if (
                file_path.is_file()
                and not file_path.name.startswith("~$")
                and file_path.suffix.lower() in {".xlsx", ".xls", ".csv"}
            ):
                files.append(file_path)
    return files


def load_manifest() -> dict[str, Any]:
    if MANIFEST_PATH.exists():
        with MANIFEST_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    return {"files": {}, "history": []}


def build_report_text(
    timestamp_label: str,
    reports: list[FileParseReport],
    diff: MergeDiff,
    applied: bool,
    latest_seed_path: Path | None = None,
    latest_db_path: Path | None = None,
) -> str:
    lines: list[str] = []
    lines.append("=" * 72)
    lines.append(f"HOUSING INSPECTION DATASET UPDATION REPORT ({timestamp_label})")
    lines.append("=" * 72)
    lines.append(f"Status: {'APPLIED' if applied else 'DRY RUN / PREVIEW ONLY'}")
    lines.append("")
    lines.append("1. NEW / MODIFIED EXCEL FILES PROCESSED:")
    for r in reports:
        lines.append(f"  - {r.rel_path} (rows extracted: {r.rows_extracted}, sha256: {r.file_hash[:12]}...)")
        if r.sheets_processed:
            lines.append(f"      Processed sheets: {', '.join(r.sheets_processed)}")
        if r.sheets_skipped:
            lines.append(f"      Skipped sheets  : {', '.join(r.sheets_skipped)}")

    lines.append("")
    lines.append("2. DATABASE CHANGE SUMMARY:")
    lines.append(f"  - Previous total records : {diff.previous_count}")
    lines.append(f"  - New records added      : {len(diff.added_records)}")
    lines.append(f"  - Existing rows enriched : {len(diff.enriched_records)}")
    lines.append(f"  - Unchanged duplicates   : {diff.unchanged_duplicates}")
    lines.append(f"  - Updated total records  : {diff.final_count}")

    if diff.added_records:
        location_counts = Counter(
            (r.get("district_name") or "(Unspecified)", r.get("city_name") or "(Unspecified)")
            for r in diff.added_records
        )
        lines.append("")
        lines.append("3. NEWLY ADDED RECORDS BY DISTRICT / CITY:")
        for (dist, city), cnt in sorted(location_counts.items()):
            lines.append(f"  - {dist} / {city}: +{cnt}")

        lines.append("")
        lines.append("   Sample Added Records (up to 10):")
        for r in diff.added_records[:10]:
            lines.append(
                f"    * {r['code']} | {r.get('name', '')} | {r.get('city_name', '')}, {r.get('district_name', '')}"
            )

    if diff.enriched_records:
        lines.append("")
        lines.append(f"4. ENRICHED EXISTING RECORDS (showing up to 10 of {len(diff.enriched_records)}):")
        for entry in diff.enriched_records[:10]:
            changed_fields = ", ".join(
                f"{k}: '{old}' -> '{new}'" for k, (old, new) in entry["changes"].items()
            )
            lines.append(f"  - {entry['code']} ({entry['name']}): {changed_fields}")

    all_warnings = [w for r in reports for w in r.warnings] + diff.quality_warnings
    lines.append("")
    lines.append("5. ITEMS TO REVIEW / POTENTIAL MISTAKES:")
    if not all_warnings and not diff.conflicts:
        lines.append("  - None! No conflicts, skipped IDs, or missing critical fields detected.")
    else:
        for w in all_warnings:
            lines.append(f"  [WARNING] {w}")
        for c in diff.conflicts[:20]:
            lines.append(
                f"  [CONFLICT] {c['code']} ({c['source']}) {c['field']}: "
                f"existing='{c['existing']}' vs incoming='{c['incoming']}'"
            )
        if len(diff.conflicts) > 20:
            lines.append(f"  ... and {len(diff.conflicts) - 20} more conflict(s).")

    if applied and latest_seed_path and latest_db_path:
        lines.append("")
        lines.append("6. GENERATED OUTPUT ARTIFACTS:")
        lines.append(f"  - App Seed JSON       : {ASSETS_DIR.relative_to(REPO_ROOT)}/{latest_seed_path.name}")
        lines.append(f"  - App Seed Loader     : {SEED_LOADER_PATH.relative_to(REPO_ROOT)}")
        lines.append(f"  - Previous (latest-1) : {PREVIOUS_SEED_PATH.relative_to(REPO_ROOT)}")
        lines.append(f"  - Latest Seed JSON    : {latest_seed_path.relative_to(REPO_ROOT)}")
        lines.append(f"  - Latest SQLite DB    : {latest_db_path.relative_to(REPO_ROOT)}")

    lines.append("=" * 72)
    return "\n".join(lines)


def get_current_asset_seed_path() -> Path | None:
    """Return the active seed JSON file in assets/ (timestamped or legacy fallback)."""
    timestamped = sorted(ASSETS_DIR.glob("beneficiaries_seed_*.json"), reverse=True)
    if timestamped:
        return timestamped[0]
    legacy = ASSETS_DIR / "beneficiaries_seed.json"
    return legacy if legacy.exists() else None


def write_seed_loader(seed_filename: str, timestamp_label: str) -> None:
    """Generate a static require() wrapper so Metro bundles the timestamped seed JSON."""
    SEED_LOADER_PATH.parent.mkdir(parents=True, exist_ok=True)
    content = (
        "// Auto-generated by databases_and_scripts/update_dataset.py — do not edit manually.\n"
        f"export const SEED_DATASET_TIMESTAMP = '{timestamp_label}';\n"
        f"export const SEED_DATA = require('../assets/{seed_filename}');\n"
    )
    with SEED_LOADER_PATH.open("w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def rotate_old_timestamped_snapshots() -> None:
    """Keep only latest-1 (`beneficiaries_seed_previous.json`), logs, manifest, and the newest snapshot."""
    for pattern in ("beneficiaries_seed_20*.json", "housing_inspection_20*.db"):
        for old_file in PROCESSED_DIR.glob(pattern):
            old_file.unlink()


def run_incremental_updation(
    yes: bool = False,
    dry_run: bool = False,
    reprocess_all: bool = False,
    baseline_seed_path: Path | None = None,
) -> int:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest()
    processed_files_meta: dict[str, Any] = manifest.get("files", {})

    discovered = discover_dataset_files()
    if not discovered:
        print("No Excel or CSV files found in databases_and_scripts/ (or dataset/).")
        return 0

    pending_paths: list[Path] = []
    for path in discovered:
        rel_key = str(path.relative_to(REPO_ROOT)).replace("\\", "/")
        current_hash = compute_sha256(path)
        prev_entry = processed_files_meta.get(rel_key)
        if reprocess_all or not prev_entry or prev_entry.get("sha256") != current_hash:
            pending_paths.append(path)

    if not pending_paths:
        print("All Excel/CSV files in databases_and_scripts/ have already been processed.")
        print(f"Manifest: {MANIFEST_PATH.relative_to(REPO_ROOT)}")
        return 0

    source_seed = baseline_seed_path or get_current_asset_seed_path()
    previous_records: list[dict[str, Any]] = []
    if source_seed and source_seed.exists():
        with source_seed.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
            if isinstance(loaded, list):
                previous_records = loaded

    reports = [parse_dataset_file(p) for p in pending_paths]

    # Reconcile slightly different city/district spellings against existing DB values.
    # For city_name, strip generic suffixes (e.g. MUNICIPALITY) and require same district_name
    # so distinct towns like "DEHGAM MUNICIPALITY" and "DEESA MUNICIPALITY" are never merged.
    def _strip_city_suffix(name: str) -> str:
        return re.sub(
            r"\b(municipality|nagar\s*palika|corporation|nagarpalika)\b",
            "",
            name.lower(),
        ).strip()

    existing_cities_by_district: dict[str, set[str]] = {}
    existing_cities_all: set[str] = set()
    existing_districts: set[str] = set()
    for r in previous_records:
        c = r.get("city_name", "").strip()
        d = r.get("district_name", "").strip()
        if c:
            existing_cities_all.add(c)
            existing_cities_by_district.setdefault(d.lower(), set()).add(c)
        if d:
            existing_districts.add(d)

    spelling_decisions: dict[tuple[str, str, str], str] = {}

    for report in reports:
        for rec in report.records:
            # First reconcile district_name, then city_name within that district
            d_val = rec.get("district_name", "").strip()
            if d_val and d_val not in existing_districts:
                d_key = ("district_name", "", d_val)
                if d_key in spelling_decisions:
                    rec["district_name"] = spelling_decisions[d_key]
                else:
                    best_match, best_ratio = "", 0.0
                    for ex in existing_districts:
                        ratio = SequenceMatcher(None, d_val.lower(), ex.lower()).ratio()
                        if ratio > best_ratio:
                            best_ratio, best_match = ratio, ex
                    if best_match and best_ratio >= 0.85:
                        should_merge = yes
                        if not yes and sys.stdin.isatty():
                            ans = input(f"\nFound similar district_name '{d_val}' -> merge into existing '{best_match}'? [y/N]: ").strip().lower()
                            should_merge = ans in {"y", "yes"}
                        chosen = best_match if should_merge else d_val
                    else:
                        chosen = d_val
                    spelling_decisions[d_key] = chosen
                    rec["district_name"] = chosen

            c_val = rec.get("city_name", "").strip()
            d_norm = rec.get("district_name", "").strip().lower()
            if not c_val or c_val in existing_cities_all:
                continue
            c_key = ("city_name", d_norm, c_val)
            if c_key in spelling_decisions:
                rec["city_name"] = spelling_decisions[c_key]
                continue
            candidates = existing_cities_by_district.get(d_norm, set()) if d_norm else existing_cities_all
            c_core = _strip_city_suffix(c_val)
            best_match, best_ratio = "", 0.0
            for ex in candidates:
                ex_core = _strip_city_suffix(ex)
                if not c_core or not ex_core:
                    continue
                ratio = SequenceMatcher(None, c_core, ex_core).ratio()
                if ratio > best_ratio:
                    best_ratio, best_match = ratio, ex
            if best_match and best_ratio >= 0.85:
                should_merge = yes
                if not yes and sys.stdin.isatty():
                    ans = input(f"\nFound similar city_name '{c_val}' -> merge into existing '{best_match}'? [y/N]: ").strip().lower()
                    should_merge = ans in {"y", "yes"}
                chosen = best_match if should_merge else c_val
            else:
                chosen = c_val
            spelling_decisions[c_key] = chosen
            rec["city_name"] = chosen

    final_records, diff = merge_and_analyze(previous_records, reports)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    preview_text = build_report_text(ts, reports, diff, applied=False)
    print(preview_text)

    if dry_run:
        print("\nDry run complete. No files were modified.")
        return 0

    if not yes:
        if not sys.stdin.isatty():
            print("\nNon-interactive terminal detected without --yes. Aborting without modifying files.")
            return 1
        answer = input("\nProceed with updating the database and generating processed artifacts? [y/N]: ").strip().lower()
        if answer not in {"y", "yes"}:
            print("Updation cancelled by user. No files were modified.")
            return 0

    # 1. Save previous (latest-1) JSON snapshot
    if source_seed and source_seed.exists():
        shutil.copy2(source_seed, PREVIOUS_SEED_PATH)
    else:
        with PREVIOUS_SEED_PATH.open("w", encoding="utf-8") as f:
            json.dump(previous_records, f, ensure_ascii=False)

    # 2. Remove older timestamped JSON/DB snapshots so latest-1 + latest stay clean
    rotate_old_timestamped_snapshots()
    for old_asset_seed in ASSETS_DIR.glob("beneficiaries_seed*.json"):
        old_asset_seed.unlink()

    # 3. Write latest timestamped JSON & SQLite DB into processed/, plus timestamped app seed in assets/
    seed_filename = f"beneficiaries_seed_{ts}.json"
    latest_seed_path = PROCESSED_DIR / seed_filename
    latest_db_path = PROCESSED_DIR / f"housing_inspection_{ts}.db"
    asset_seed_path = ASSETS_DIR / seed_filename

    with latest_seed_path.open("w", encoding="utf-8") as f:
        json.dump(final_records, f, ensure_ascii=False)

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    with asset_seed_path.open("w", encoding="utf-8") as f:
        json.dump(final_records, f, ensure_ascii=False)

    write_seed_loader(seed_filename, ts)

    ingest_into_sqlite(final_records, latest_db_path)

    # 4. Update manifest
    for r in reports:
        processed_files_meta[r.rel_path] = {
            "sha256": r.file_hash,
            "file_size": r.file_size,
            "mtime": r.mtime_iso,
            "rows_extracted": r.rows_extracted,
            "sheets_processed": r.sheets_processed,
            "sheets_skipped": r.sheets_skipped,
            "processed_at": ts,
        }
    manifest["files"] = processed_files_meta
    history = manifest.get("history", [])
    history.append(
        {
            "timestamp": ts,
            "files": [r.rel_path for r in reports],
            "previous_count": diff.previous_count,
            "added": len(diff.added_records),
            "enriched": len(diff.enriched_records),
            "final_count": diff.final_count,
            "warnings_count": sum(len(r.warnings) for r in reports) + len(diff.quality_warnings),
            "conflicts_count": len(diff.conflicts),
        }
    )
    manifest["history"] = history
    with MANIFEST_PATH.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    # 5. Write audit log file into processed/
    log_path = PROCESSED_DIR / f"updation_log_{ts}.log"
    final_log_text = build_report_text(
        ts,
        reports,
        diff,
        applied=True,
        latest_seed_path=latest_seed_path,
        latest_db_path=latest_db_path,
    )
    with log_path.open("w", encoding="utf-8") as f:
        f.write(final_log_text + "\n")

    print(f"\nDataset updation applied! Audit log saved to: {log_path.relative_to(REPO_ROOT)}")
    print("Next step: Publish your OTA update when ready (e.g., `eas update --channel production --message \"Updated beneficiary dataset\"`).")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Incrementally process new Excel/CSV sheets, validate changes, and update the app database."
    )
    parser.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Automatically confirm and apply updates without interactive prompt.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Analyze unprocessed Excel files and print review summary without modifying files.",
    )
    parser.add_argument(
        "--reprocess-all",
        action="store_true",
        help="Reprocess all dataset files regardless of manifest state.",
    )
    parser.add_argument(
        "--baseline-seed",
        type=Path,
        default=None,
        help="Optional path to a baseline seed JSON to diff against.",
    )
    args = parser.parse_args()
    sys.exit(
        run_incremental_updation(
            yes=args.yes,
            dry_run=args.dry_run,
            reprocess_all=args.reprocess_all,
            baseline_seed_path=args.baseline_seed,
        )
    )


if __name__ == "__main__":
    main()
