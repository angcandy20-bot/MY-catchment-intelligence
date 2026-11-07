"""Synthetic data for local cross-language tests (NOT real data).

Builds a small Mollweide-like grid (rows of constant latitude) around Kuala Lumpur, random population
counts, random RWI samples, then writes tiles with the real pipeline functions (write_tiles, nearest_rwi).
Expected results for test polygons are computed independently with matplotlib.path (point-in-polygon)
and brute-force haversine nearest neighbour, NOT with the dashboard's scanline code or the k-d tree.
"""
import json, os, sys, math
import numpy as np, pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import build_data as bd
from matplotlib.path import Path

out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/synth"
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(42)

# grid: 0.0009 deg steps (~100 m), lon 101.55..101.80, lat 3.05..3.30 -> crosses tile borders at 101.75 / 3.25
lats = np.arange(3.05, 3.30, 0.0009) + 0.00045
lons = np.arange(101.55, 101.80, 0.0009) + 0.00045
LA, LO = np.meshgrid(lats, lons, indexing="ij")
rows = np.repeat(np.arange(len(lats)), len(lons)).astype(np.int32)
lat = LA.ravel(); lon = LO.ravel()
pop = rng.gamma(0.6, 40, size=lat.size)
pop[rng.random(lat.size) < 0.35] = 0          # zeros (dropped like NoData/zero cells)
keep = pop > 0
rows, lat, lon, pop = rows[keep], lat[keep], lon[keep], pop[keep]

# RWI samples: sparse, ~2.4 km spacing over part of the area only (so some cells are unmatched beyond 3 km)
rl = np.arange(3.06, 3.22, 0.022); ro = np.arange(101.56, 101.72, 0.022)
RL, RO = np.meshgrid(rl, ro, indexing="ij")
rdf = pd.DataFrame({"latitude": RL.ravel() + rng.normal(0, 0.002, RL.size), "longitude": RO.ravel() + rng.normal(0, 0.002, RL.size)})
rdf["rwi"] = rng.normal(0.2, 0.5, len(rdf)); rdf["error"] = rng.uniform(0.2, 0.6, len(rdf))

idx, dist = bd.nearest_rwi(lat, lon, rdf)
rwi_val = rdf.rwi.values[idx].astype(np.float32)
dist_m = np.minimum(np.ceil(dist), bd.NO_MATCH).astype(np.uint16)
tiles, nbytes = bd.write_tiles(out, rows, lon, lat, pop, rwi_val, dist_m)
manifest = {"format": "MCT1", "data_version": "synthetic", "tile_deg": bd.TILE_DEG, "tiles": tiles,
            "population": {"note": "SYNTHETIC TEST DATA"}, "rwi": {"samples": len(rdf)}}
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"))

# ---- independent expected values
R = 6371008.8
def hav(la1, lo1, la2, lo2):
    p1, p2 = np.radians(la1), np.radians(la2); dphi = p2 - p1; dl = np.radians(lo2 - lo1)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(a))

# brute-force nearest for every cell (independent of the k-d tree); use float32 coords as stored in tiles
lat32 = lat.astype(np.float32).astype(float); lon32 = lon.astype(np.float32).astype(float)
bf_d = np.full(lat.size, np.inf); bf_v = np.zeros(lat.size)
for j in range(len(rdf)):
    d = hav(lat, lon, rdf.latitude.values[j], rdf.longitude.values[j])
    better = d < bf_d; bf_d[better] = d[better]; bf_v[better] = rdf.rwi.values[j]

def inside(poly_list):
    pts = np.c_[lon32, lat32]; res = np.zeros(len(pts), bool)
    for rings in poly_list:
        ins = Path(rings[0]).contains_points(pts)
        for h in rings[1:]:
            ins &= ~Path(h).contains_points(pts)
        res |= ins
    return res

sq = lambda x0, y0, x1, y1: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
cases = {
    "square_crossing_tile_corner": {"type": "Polygon", "coordinates": [sq(101.70, 3.20, 101.78, 3.28)]},
    "polygon_with_two_holes": {"type": "Polygon", "coordinates": [sq(101.58, 3.07, 101.70, 3.18), sq(101.60, 3.09, 101.63, 3.12)[::-1], sq(101.65, 3.13, 101.68, 3.16)[::-1]]},
    "multipolygon_two_parts": {"type": "MultiPolygon", "coordinates": [[sq(101.56, 3.06, 101.59, 3.09)], [sq(101.74, 3.24, 101.79, 3.29)]]},
    "concave_star": {"type": "Polygon", "coordinates": [[[101.65 + (0.05 if k % 2 == 0 else 0.02) * math.cos(k * math.pi / 6), 3.15 + (0.05 if k % 2 == 0 else 0.02) * math.sin(k * math.pi / 6)] for k in range(12)] + [[101.70, 3.15]]]},
    "outside_rwi_area_unmatched": {"type": "Polygon", "coordinates": [sq(101.76, 3.26, 101.79, 3.29)]},
    "empty_sea_polygon": {"type": "Polygon", "coordinates": [sq(102.5, 2.5, 102.6, 2.6)]},
}
expected = {}
for name, g in cases.items():
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    m = inside(polys)
    for thr in (3000, 1000):
        matched = m & (bf_d <= thr)
        tot = float(pop[m].sum()); mp = float(pop[matched].sum())
        expected[f"{name}@{thr}"] = {
            "population": tot, "matched_population": mp,
            "population_weighted_rwi": (float((pop[matched] * bf_v[matched]).sum()) / mp) if mp > 0 else None,
            "wealth_coverage": (mp / tot) if tot > 0 else None, "cells": int(m.sum()),
        }
json.dump({"cases": cases, "expected": expected}, open(os.path.join(out, "expected.json"), "w"))
print("synthetic tiles:", len(tiles), "cells:", int(lat.size), "rwi samples:", len(rdf))
