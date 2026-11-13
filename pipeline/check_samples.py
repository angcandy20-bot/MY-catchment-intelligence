#!/usr/bin/env python3
"""Independent sample check against the ORIGINAL raster and RWI table (no dashboard code, no tiles).

Population: polygon (densified, reprojected to the raster CRS) rasterised with GDAL's cell-centre rule
(rasterio.features.geometry_mask, all_touched=False), raster values summed excluding NoData / <= 0.
RWI: nearest sample with scikit-learn BallTree (haversine), threshold 3 km.
Area: pyproj.Geod (WGS84 ellipsoid).
Income/spending: cell centres joined to the full-resolution area polygons with geopandas (independent of the
pipeline's per-cell index), household-weighted averages recomputed from areas.json values.
Usage: python check_samples.py <population.tif> <rwi.csv|zip> <samples.geojson> <out.json> [areas_full.geojson areas.json]
"""
import json, sys, zipfile
import numpy as np, pandas as pd
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds, Window
from pyproj import Transformer, Geod, CRS
from shapely.geometry import shape, mapping
from shapely.ops import transform as stransform
from sklearn.neighbors import BallTree

pop_path, rwi_path, samples_path, out_path = sys.argv[1:5]
areas_full = sys.argv[5] if len(sys.argv) > 5 else None
areas_tab = json.load(open(sys.argv[6]))["areas"] if len(sys.argv) > 6 else None
if areas_full:
    import geopandas as gpd
    AG = gpd.read_file(areas_full)[["id", "geometry"]]
    AG3857 = AG.to_crs(3857)

def econ_check(lon, lat, vals):
    if not areas_full or not len(vals):
        return {}
    pts = gpd.GeoDataFrame({"k": np.arange(len(vals))}, geometry=gpd.points_from_xy(lon, lat), crs=4326)
    j = gpd.sjoin(pts, AG, how="left", predicate="within"); j = j[~j.index.duplicated(keep="first")]
    ids = j["id"].values.astype(float)
    miss = np.isnan(ids)
    if miss.any():
        n = gpd.sjoin_nearest(pts[miss].to_crs(3857), AG3857, how="left", max_distance=1000); n = n[~n.index.duplicated(keep="first")]
        ids[np.nonzero(miss)[0]] = n["id"].values.astype(float)
    hh = np.zeros(len(vals)); med = np.full(len(vals), np.nan); mean = np.full(len(vals), np.nan); exp = np.full(len(vals), np.nan)
    for k, a in enumerate(ids):
        if np.isnan(a):
            continue
        A = areas_tab[int(a)]
        hh[k] = vals[k] / A["hh_size"]
        med[k] = np.nan if A["income_median"] is None else A["income_median"]
        mean[k] = np.nan if A["income_mean"] is None else A["income_mean"]
        exp[k] = np.nan if A["expenditure_mean"] is None else A["expenditure_mean"]
    def wavg(x):
        m = ~np.isnan(x) & (hh > 0)
        return float((hh[m] * x[m]).sum() / hh[m].sum()) if m.any() else None
    m = ~np.isnan(exp)
    return {"est_households": float(hh.sum()) if hh.sum() > 0 else None, "income_median_hh_avg": wavg(med), "income_mean_hh_avg": wavg(mean),
            "expenditure_mean_hh_avg": wavg(exp), "spending_power_rm_month": float((hh[m] * exp[m]).sum()) if m.any() else None,
            "econ_coverage": float(vals[~np.isnan(ids)].sum() / vals.sum())}
THR = 3000.0; R = 6371008.8

if rwi_path.endswith(".zip"):
    z = zipfile.ZipFile(rwi_path); rwi = pd.read_csv(z.open([n for n in z.namelist() if n.endswith(".csv")][0]))
else:
    rwi = pd.read_csv(rwi_path)
rwi.columns = [c.lower().strip() for c in rwi.columns]
rwi = rwi.dropna(subset=["latitude", "longitude", "rwi"])
tree = BallTree(np.radians(rwi[["latitude", "longitude"]].values), metric="haversine")

src = rasterio.open(pop_path)
crs = CRS.from_user_input(src.crs)
fwd = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
inv = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
geod = Geod(ellps="WGS84")
out = []
for f in json.load(open(samples_path))["features"]:
    g = shape(f["geometry"])
    gd = g.segmentize(0.0005)  # densify so straight lat/lon edges stay straight after projection
    gp = stransform(lambda x, y, z=None: fwd.transform(x, y), gd)
    b = gp.bounds
    win = from_bounds(*b, transform=src.transform).round_offsets(op="floor").round_lengths(op="ceil")
    win = Window(win.col_off - 1, win.row_off - 1, win.width + 2, win.height + 2).intersection(Window(0, 0, src.width, src.height))
    arr = src.read(1, window=win).astype(np.float64)
    wt = src.window_transform(win)
    inside = geometry_mask([mapping(gp)], out_shape=arr.shape, transform=wt, invert=True, all_touched=False)
    valid = np.isfinite(arr) & (arr > 0)
    if src.nodata is not None:
        valid &= arr != src.nodata
    sel = inside & valid
    rr, cc = np.nonzero(sel)
    vals = arr[rr, cc]
    xs = wt.c + (cc + 0.5) * wt.a; ys = wt.f + (rr + 0.5) * wt.e
    lon, lat = inv.transform(xs, ys)
    total = float(vals.sum())
    if len(vals):
        d, i = tree.query(np.radians(np.c_[lat, lon]), k=1)
        dist = d[:, 0] * R; rv = rwi.rwi.values[i[:, 0]]
        m = dist <= THR
        mp = float(vals[m].sum()); wsum = float((vals[m] * rv[m]).sum())
    else:
        mp = 0.0; wsum = 0.0
    area = abs(geod.geometry_area_perimeter(g)[0]) / 1e6
    out.append({"name": f["properties"]["name"], "population": total, "cells": int(len(vals)), "matched_population": mp,
                "population_weighted_rwi": wsum / mp if mp > 0 else None, "wealth_coverage": mp / total if total > 0 else None,
                "area_km2_ellipsoid": area, "geometry": f["geometry"], **econ_check(np.asarray(lon), np.asarray(lat), vals)})
    print(out[-1]["name"], round(total), out[-1]["population_weighted_rwi"], flush=True)
json.dump(out, open(out_path, "w"), indent=1)
