#!/usr/bin/env python3
"""Build the dashboard's population / RWI data from HDX.

Steps
1. Locate resources through the HDX CKAN API (dataset pages mys-ghsl and relative-wealth-index).
2. Download them and verify year, version, units, CRS, resolution and NoData conventions.
3. Keep every populated raster cell at its ORIGINAL resolution. Each cell's population COUNT is stored with
   its cell-centre coordinates (raster CRS -> WGS84). Density values are never summed.
4. Match each cell to its nearest valid RWI sample by great-circle distance (unit-sphere k-d tree).
   The distance is stored so the browser can apply a configurable threshold (default 3 km).
5. Write 0.25-degree binary tiles + manifest.json + rwi.json, and a verification report.

Usage: python build_data.py --work work --out site/data
"""
import argparse, hashlib, json, math, os, re, sys, time, zipfile, io
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

HDX_API = "https://data.humdata.org/api/3/action/package_show?id="
UA = {"User-Agent": "malaysia-catchment-dashboard-build/1.0 (GitHub Actions; data pipeline)"}
TILE_DEG = 0.25
R_EARTH = 6371008.8  # mean Earth radius (m) for great-circle distances
NO_MATCH = 65535

report = {"generated_at": datetime.now(timezone.utc).isoformat(), "population": {}, "rwi": {}, "notes": []}


def log(*a):
    print(*a, flush=True)


def package(pid):
    r = requests.get(HDX_API + pid, headers=UA, timeout=60)
    r.raise_for_status()
    j = r.json()
    if not j.get("success"):
        raise RuntimeError(f"HDX package_show failed for {pid}")
    return j["result"]


def res_summary(r):
    return {k: r.get(k) for k in ("name", "format", "size", "url", "last_modified", "created", "description")}


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        log("cached", path)
        return path
    log("downloading", url)
    with requests.get(url, headers=UA, stream=True, timeout=600, allow_redirects=True) as r:
        r.raise_for_status()
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------- population
def pick_population(resources):
    """Return (resource, choice_note). Preference: GHS-POP E2025 R2023A 100 m GeoTIFF."""
    def nm(r):  # name + url only (descriptions often mention several resolutions)
        return (str(r.get("name") or "") + " " + str(r.get("url") or "")).upper()

    def is_raster(r):
        t = nm(r) + " " + str(r.get("format") or "").upper()
        return any(s in t for s in ("TIF", "GEOTIFF", "ZIP"))

    def res100(t):
        return bool(re.search(r"(?<!\d)100(?!\d)|100M(?!\d)", t)) and not re.search(r"(?<!\d)1000(?!\d)|1KM", t)

    cands = [r for r in resources if is_raster(r) and "POP" in nm(r)]
    tiers = [
        ("preferred: GHS-POP E2025 R2023A 100 m (Mollweide)", lambda t: "E2025" in t and "R2023A" in t and res100(t) and "54009" in t),
        ("preferred: GHS-POP E2025 R2023A 100 m", lambda t: "E2025" in t and "R2023A" in t and res100(t)),
        ("preferred: GHS-POP 2025 100 m", lambda t: "2025" in t and res100(t)),
        ("alternative: E2025 at 3 arc-seconds (WGS84, ~90 m)", lambda t: "E2025" in t and ("3SS" in t or "_4326_3" in t)),
        ("alternative: E2020 at 100 m", lambda t: "E2020" in t and res100(t)),
        ("alternative: other GHS-POP 100 m epoch", lambda t: res100(t)),
    ]
    for note, test in tiers:
        hit = [r for r in cands if test(nm(r))]
        if hit:
            return hit[0], note
    return None, "none"


def open_population(path, workdir):
    import rasterio
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            tifs = [n for n in z.namelist() if n.lower().endswith((".tif", ".tiff"))]
            if not tifs:
                raise RuntimeError("zip contains no GeoTIFF")
            z.extractall(workdir)
            paths = [os.path.join(workdir, n) for n in tifs]
    else:
        paths = [path]
    if len(paths) > 1:
        from rasterio.merge import merge
        srcs = [rasterio.open(p) for p in paths]
        arr, transform = merge(srcs)
        meta = srcs[0].meta.copy()
        meta.update(height=arr.shape[1], width=arr.shape[2], transform=transform)
        out = os.path.join(workdir, "pop_mosaic.tif")
        with rasterio.open(out, "w", **meta) as dst:
            dst.write(arr)
        return out, paths
    return paths[0], paths


def build_population(pop_path):
    import rasterio
    from pyproj import CRS, Transformer
    src = rasterio.open(pop_path)
    crs = CRS.from_user_input(src.crs)
    info = {
        "file": os.path.basename(pop_path), "crs_wkt_name": crs.name, "crs_epsg": crs.to_epsg(),
        "crs_authority": crs.to_authority(), "is_geographic": crs.is_geographic,
        "width": src.width, "height": src.height, "resolution": list(src.res),
        "resolution_units": "degrees" if crs.is_geographic else "metres",
        "bounds": list(src.bounds), "dtype": src.dtypes[0], "nodata": src.nodata,
        "band_tags": src.tags(1), "dataset_tags": src.tags(), "units": "people per cell (count)",
    }
    log("population raster:", json.dumps(info, default=str)[:800])
    tr = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    T = src.transform
    nodata = src.nodata
    lats_row, rows_all, lons_all, pops_all = [], [], [], []
    total = 0.0; n_nodata = 0; n_zero = 0; n_neg = 0; n_valid = 0; max_dev = 0.0
    step = 256
    for r0 in range(0, src.height, step):
        h = min(step, src.height - r0)
        a = src.read(1, window=((r0, r0 + h), (0, src.width))).astype(np.float64)
        nd = ~np.isfinite(a)
        if nodata is not None:
            nd |= (a == nodata)
        n_nodata += int(nd.sum())
        n_neg += int(((a < 0) & ~nd).sum())
        valid = (~nd) & (a > 0)
        n_zero += int(((a == 0) & ~nd).sum())
        if not valid.any():
            continue
        rr, cc = np.nonzero(valid)
        vals = a[rr, cc]
        rr = rr + r0
        x = T.c + (cc + 0.5) * T.a + (rr + 0.5) * T.b
        y = T.f + (cc + 0.5) * T.d + (rr + 0.5) * T.e
        lon, lat = tr.transform(x, y)
        lon = np.asarray(lon); lat = np.asarray(lat)
        rows_all.append(rr.astype(np.int32)); lons_all.append(lon); lats_row.append(lat); pops_all.append(vals)
        total += float(vals.sum()); n_valid += len(vals)
    rows = np.concatenate(rows_all); lon = np.concatenate(lons_all); lat = np.concatenate(lats_row); pop = np.concatenate(pops_all)
    # every cell of one raster row must share a latitude (true for Mollweide and lat/lon grids)
    order = np.argsort(rows, kind="stable")
    rs = rows[order]; ls = lat[order]
    starts = np.r_[0, np.nonzero(np.diff(rs))[0] + 1]
    first = np.repeat(ls[starts], np.diff(np.r_[starts, len(rs)]))
    max_dev = float(np.max(np.abs(ls - first))) if len(ls) else 0.0
    info.update({"populated_cells": n_valid, "nodata_cells": n_nodata, "zero_cells": n_zero, "negative_non_nodata_cells": n_neg,
                 "population_total": total, "row_latitude_max_deviation_deg": max_dev})
    if max_dev > 1e-7:
        raise RuntimeError(f"Raster rows do not have constant latitude (max dev {max_dev}); unsupported CRS")
    lat_by_row = np.empty_like(lat)
    lat_by_row[order] = first  # every cell gets its row's latitude exactly
    return rows, lon, lat_by_row, pop, info


# ---------------------------------------------------------------- RWI
def pick_rwi(resources):
    def txt(r):
        return " ".join(str(r.get(k) or "") for k in ("name", "url", "description")).lower()
    hits = [r for r in resources if ("mys" in txt(r) or "malaysia" in txt(r))]
    hits.sort(key=lambda r: (0 if "csv" in str(r.get("format", "")).lower() else 1))
    return hits[0] if hits else None


def load_rwi(path):
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".csv")]
            df = pd.read_csv(z.open(names[0]))
    else:
        df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    need = {"latitude", "longitude", "rwi"}
    if not need.issubset(df.columns):
        raise RuntimeError(f"RWI columns missing; found {list(df.columns)}")
    n0 = len(df)
    for c in ("latitude", "longitude", "rwi", "error"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    bad = df["rwi"].isna() | df["latitude"].isna() | df["longitude"].isna()
    info = {"fields": list(df.columns), "rows_total": n0, "rows_missing_rwi_or_coords": int(bad.sum())}
    df = df[~bad].copy()
    dup = df.duplicated(subset=["latitude", "longitude"]).sum()
    info.update({"rows_valid": len(df), "duplicate_coordinates": int(dup),
                 "rwi_min": float(df.rwi.min()), "rwi_max": float(df.rwi.max()), "rwi_mean": float(df.rwi.mean()),
                 "lat_range": [float(df.latitude.min()), float(df.latitude.max())],
                 "lon_range": [float(df.longitude.min()), float(df.longitude.max())]})
    if "error" in df.columns:
        info.update({"error_min": float(df.error.min()), "error_max": float(df.error.max()), "error_mean": float(df.error.mean())})
    if "quadkey" in df.columns:
        qk = df["quadkey"].astype(str).str.len()
        info["quadkey_length_mode"] = int(qk.mode().iloc[0])
        z = info["quadkey_length_mode"]
        info["approx_tile_size_km_at_equator"] = round(40075.017 / 2 ** z, 2)
    return df, info


def ecef(lat, lon):
    la = np.radians(lat); lo = np.radians(lon)
    return np.c_[np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)]


def nearest_rwi(lat, lon, rwi_df):
    from scipy.spatial import cKDTree
    tree = cKDTree(ecef(rwi_df.latitude.values, rwi_df.longitude.values))
    out_d = np.empty(len(lat)); out_i = np.empty(len(lat), dtype=np.int64)
    step = 1_000_000
    for s in range(0, len(lat), step):
        d, i = tree.query(ecef(lat[s:s + step], lon[s:s + step]), k=1)
        out_d[s:s + step] = d; out_i[s:s + step] = i
    geod = 2 * R_EARTH * np.arcsin(np.clip(out_d / 2, 0, 1))  # chord -> great-circle metres
    return out_i, geod


# ---------------------------------------------------------------- tiles
def write_tiles(out_dir, rows, lon, lat, pop, rwi_val, dist_m, area=None):
    os.makedirs(os.path.join(out_dir, "tiles"), exist_ok=True)
    ix = np.floor(lon / TILE_DEG).astype(np.int32); iy = np.floor(lat / TILE_DEG).astype(np.int32)
    if area is None:
        area = np.full(len(lon), 65535, dtype=np.uint16)
    order = np.lexsort((lon, rows, iy, ix))
    ix, iy, rows, lon, lat, pop, rwi_val, dist_m, area = (a[order] for a in (ix, iy, rows, lon, lat, pop, rwi_val, dist_m, area))
    key = ix.astype(np.int64) * 100000 + iy
    bounds = np.r_[0, np.nonzero(np.diff(key))[0] + 1, len(key)]
    tiles = []; total_bytes = 0
    for b0, b1 in zip(bounds[:-1], bounds[1:]):
        r = rows[b0:b1]
        rstarts = np.r_[0, np.nonzero(np.diff(r))[0] + 1]
        row_lat = lat[b0:b1][rstarts].astype(np.float32)
        row_start = np.r_[rstarts, b1 - b0].astype(np.uint32)
        n = b1 - b0
        tid = f"{int(ix[b0])}_{int(iy[b0])}"
        buf = io.BytesIO()
        buf.write(b"MCT2"); buf.write(np.array([len(row_lat), n], dtype="<u4").tobytes())
        buf.write(row_lat.astype("<f4").tobytes()); buf.write(row_start.astype("<u4").tobytes())
        buf.write(lon[b0:b1].astype("<f4").tobytes()); buf.write(pop[b0:b1].astype("<f4").tobytes())
        buf.write(rwi_val[b0:b1].astype("<f4").tobytes()); buf.write(dist_m[b0:b1].astype("<u2").tobytes())
        buf.write(area[b0:b1].astype("<u2").tobytes())
        data = buf.getvalue()
        with open(os.path.join(out_dir, "tiles", tid + ".bin"), "wb") as f:
            f.write(data)
        total_bytes += len(data)
        lo32 = lon[b0:b1].astype(np.float32); la32 = row_lat
        tiles.append({"id": tid, "file": f"tiles/{tid}.bin", "n": int(n), "pop": round(float(pop[b0:b1].sum()), 1),
                      "bbox": [float(lo32.min()), float(la32.min()), float(lo32.max()), float(la32.max())], "bytes": len(data)})
    return tiles, total_bytes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="work"); ap.add_argument("--out", default="site/data")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True); os.makedirs(a.out, exist_ok=True)

    # ---- population
    pk = package("mys-ghsl")
    report["population"]["hdx_dataset"] = {k: pk.get(k) for k in ("name", "title", "dataset_date", "last_modified", "dataset_source", "license_title", "methodology", "methodology_other", "caveats")}
    report["population"]["hdx_resources"] = [res_summary(r) for r in pk["resources"]]
    res, note = pick_population(pk["resources"])
    if not res:
        raise SystemExit("No GHS-POP GeoTIFF resource found on HDX mys-ghsl; see report.")
    report["population"]["selected_resource"] = res_summary(res); report["population"]["selection"] = note
    log("population resource:", res.get("name"), "|", note)
    fn = os.path.join(a.work, re.sub(r"[^A-Za-z0-9._-]", "_", res.get("name") or "pop") )
    if not re.search(r"\.(zip|tif|tiff)$", fn, re.I):
        fn += ".zip" if "zip" in str(res.get("url", "")).lower() else ".tif"
    download(res["url"], fn)
    pop_path, parts = open_population(fn, os.path.join(a.work, "pop_extract"))
    rows, lon, lat, pop, pinfo = build_population(pop_path)
    pinfo["source_parts"] = [os.path.basename(p) for p in parts]
    report["population"]["raster"] = pinfo
    m = re.search(r"E(\d{4})", (res.get("name") or "") + (res.get("url") or ""), re.I)
    v = re.search(r"R(\d{4}[A-Z])", (res.get("name") or "") + (res.get("url") or ""), re.I)
    report["population"]["epoch"] = m.group(1) if m else None
    report["population"]["release"] = ("R" + v.group(1).upper()) if v else None

    # ---- RWI
    pr = package("relative-wealth-index")
    report["rwi"]["hdx_dataset"] = {k: pr.get(k) for k in ("name", "title", "dataset_date", "last_modified", "dataset_source", "license_title", "methodology", "methodology_other", "caveats")}
    rres = pick_rwi(pr["resources"])
    if not rres:
        report["rwi"]["hdx_resources"] = [res_summary(r) for r in pr["resources"]]
        raise SystemExit("No Malaysia resource in relative-wealth-index")
    report["rwi"]["selected_resource"] = res_summary(rres)
    rfn = os.path.join(a.work, "rwi_" + re.sub(r"[^A-Za-z0-9._-]", "_", rres.get("name") or "mys.csv"))
    download(rres["url"], rfn)
    rdf, rinfo = load_rwi(rfn)
    report["rwi"]["table"] = rinfo

    # ---- nearest RWI (geodesic, spherical)
    idx, dist = nearest_rwi(lat, lon, rdf)
    rwi_val = rdf.rwi.values[idx].astype(np.float32)
    dist_m = np.minimum(np.ceil(dist), NO_MATCH).astype(np.uint16)  # ceil: stored <= T (whole metres) iff true distance <= T
    within3 = dist <= 3000
    report["matching"] = {
        "method": "nearest valid RWI sample by great-circle distance (unit-sphere k-d tree, R=6371008.8 m)",
        "stored_distance": "metres, rounded UP (ceil), uint16, 65535 = >= 65.5 km",
        "default_threshold_m": 3000,
        "population_share_within_3km": float(pop[within3].sum() / pop.sum()),
        "distance_percentiles_m": {str(q): float(np.percentile(dist, q)) for q in (50, 90, 99, 99.9)},
    }

    # ---- household income & spending areas (DOSM HIES)
    from build_econ import build_econ
    area_idx, econ = build_econ(a.work, a.out, lon, lat, report)

    # ---- tiles
    tiles, nbytes = write_tiles(a.out, rows, lon, lat, pop, rwi_val, dist_m, area_idx)
    data_version = hashlib.sha1(json.dumps([t["id"] + str(t["n"]) + str(t["pop"]) for t in tiles] + [open(os.path.join(a.out, "areas.json")).read()]).encode()).hexdigest()[:10]
    rwi_out = {"fields": ["lat", "lon", "rwi", "error"],
               "lat": [round(x, 5) for x in rdf.latitude.tolist()], "lon": [round(x, 5) for x in rdf.longitude.tolist()],
               "rwi": [round(x, 4) for x in rdf.rwi.tolist()],
               "error": [round(x, 4) for x in rdf["error"].tolist()] if "error" in rdf.columns else []}
    with open(os.path.join(a.out, "rwi.json"), "w") as f:
        json.dump(rwi_out, f, separators=(",", ":"))
    manifest = {
        "format": "MCT2", "econ": econ, "data_version": data_version, "built_at": report["generated_at"], "tile_deg": TILE_DEG,
        "population": {
            "dataset": "GHS-POP (JRC Global Human Settlement Layer) via HDX mys-ghsl",
            "resource": res.get("name"), "selection": note, "epoch": report["population"]["epoch"], "release": report["population"]["release"],
            "crs": pinfo["crs_wkt_name"], "crs_authority": pinfo["crs_authority"], "resolution": pinfo["resolution"], "resolution_units": pinfo["resolution_units"],
            "units": "people per cell (count)", "nodata": pinfo["nodata"], "total": round(pinfo["population_total"]), "cells": pinfo["populated_cells"],
            "hdx_last_modified": res.get("last_modified"), "url": "https://data.humdata.org/dataset/mys-ghsl",
        },
        "rwi": {
            "dataset": "Meta Relative Wealth Index via HDX relative-wealth-index", "resource": rres.get("name"),
            "dataset_date": pr.get("dataset_date"), "hdx_last_modified": rres.get("last_modified"), "samples": rinfo["rows_valid"],
            "approx_tile_size_km": rinfo.get("approx_tile_size_km_at_equator") or 2.4,  # 2.4 km per HDX methodology when no quadkey column "url": "https://data.humdata.org/dataset/relative-wealth-index",
        },
        "matching": report["matching"],
        "tiles": tiles, "total_bytes": nbytes,
    }
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"), default=str)
    report["output"] = {"tiles": len(tiles), "bytes": nbytes, "data_version": data_version}
    with open(os.path.join(a.work, "paths.json"), "w") as f:
        json.dump({"population": pop_path, "rwi": rfn, "areas_full": os.path.join(a.work, "areas_full.geojson"), "areas_json": os.path.join(a.out, "areas.json")}, f)
    with open(os.path.join(a.out, "data_report.json"), "w") as f:
        json.dump(report, f, indent=1, default=str)
    log("done:", len(tiles), "tiles,", round(nbytes / 1e6, 1), "MB; population total", round(pinfo["population_total"]))


if __name__ == "__main__":
    main()
