"""Household income & spending (DOSM HIES) by small area, linked to population cells.

Areas: the 600 state-assembly constituencies (DUN) of the 13 states, plus the parliamentary
constituencies of the 3 Federal Territories (which have no DUNs).
Values: latest HIES year in DOSM's open tables (hh_income_dun / hh_expenditure_dun /
hh_income_parlimen / hh_expenditure_parlimen). Average household size by state = households
(hh_profile_state) / population (population_state), same year.
Each population cell gets the index of the area containing its centre.
"""
import json, os, re
import numpy as np, pandas as pd, requests

UA = {"User-Agent": "malaysia-catchment-dashboard-build/1.0 (GitHub Actions; data pipeline)"}
FT = {"W.P. Kuala Lumpur", "W.P. Putrajaya", "W.P. Labuan"}
NO_AREA = 65535


def log(*a):
    print("[econ]", *a, flush=True)


def get_table(tid, folder="hies"):
    """DOSM parquet from storage, falling back to the data.gov.my API."""
    for url in (f"https://storage.dosm.gov.my/{folder}/{tid}.parquet",):
        try:
            r = requests.get(url, headers=UA, timeout=120)
            if r.ok and r.content[:4] == b"PAR1":
                import io
                return pd.read_parquet(io.BytesIO(r.content)), url
        except Exception as e:  # noqa
            log("parquet failed", url, e)
    url = f"https://api.data.gov.my/data-catalogue?id={tid}&limit=100000"
    r = requests.get(url, headers=UA, timeout=120); r.raise_for_status()
    return pd.DataFrame(r.json()), url


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def code_of(s, kind):
    m = re.search(r"\b([PN])\.?\s?0*(\d+)", str(s))
    return f"{m.group(1)}{int(m.group(2))}" if m else norm(s)


def norm_state(s):
    s = str(s).strip()
    aliases = {"kuala lumpur": "W.P. Kuala Lumpur", "wp kuala lumpur": "W.P. Kuala Lumpur", "putrajaya": "W.P. Putrajaya",
               "wp putrajaya": "W.P. Putrajaya", "labuan": "W.P. Labuan", "wp labuan": "W.P. Labuan", "penang": "Pulau Pinang",
               "malacca": "Melaka", "negri sembilan": "Negeri Sembilan"}
    k = re.sub(r"[^a-z ]", "", s.lower()).replace("  ", " ").strip()
    return aliases.get(k, s)


def latest(df, value_cols):
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])
    y = df["date"].max()
    return df[df["date"] == y], int(y.year)


def find_boundaries(report):
    """Locate DUN and parliament GeoJSON in DOSM's public GitHub repositories."""
    tried = []
    for owner, repo in [("dosm-malaysia", "data-open"), ("dosm-malaysia", "aksara-data"), ("dosm-malaysia", "aksara-front"), ("Thevesh", "paper-meco-maps")]:
        r = requests.get(f"https://api.github.com/repos/{owner}/{repo}/git/trees/HEAD?recursive=1", headers=UA, timeout=60)
        tried.append(f"{owner}/{repo}: HTTP {r.status_code}")
        if not r.ok:
            continue
        paths = [t["path"] for t in r.json().get("tree", []) if t["path"].lower().endswith(".geojson")]
        dun = [p for p in paths if re.search(r"dun", p, re.I)]
        par = [p for p in paths if re.search(r"parlimen|parliament", p, re.I)]
        report["boundary_search"] = {"repo": f"{owner}/{repo}", "geojson_files": paths[:200], "tried": tried}
        if dun and par:
            pick = lambda xs: sorted(xs, key=lambda p: (("2018" not in p and "2019" not in p and "electoral" not in p), len(p)))[0]
            return owner, repo, pick(dun), pick(par)
    report["boundary_search"] = report.get("boundary_search", {}) | {"tried": tried}
    raise RuntimeError("DUN/parliament GeoJSON not found: " + "; ".join(tried))


def read_geo(owner, repo, path, work):
    import geopandas as gpd
    fn = os.path.join(work, "geo_" + os.path.basename(path))
    if not os.path.exists(fn):
        url = f"https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}"
        r = requests.get(url, headers=UA, timeout=300); r.raise_for_status()
        open(fn, "wb").write(r.content)
    g = gpd.read_file(fn)
    if g.crs is None:
        g = g.set_crs(4326)
    return g.to_crs(4326)


def pick_col(cols, *keys):
    for k in keys:
        for c in cols:
            if c.lower() == k:
                return c
    for k in keys:
        for c in cols:
            if k in c.lower():
                return c
    return None


def assign_points(pts, gdf):
    """Index of the polygon (gdf['id']) containing each point; nearest within 1 km for coastline slivers."""
    import geopandas as gpd
    idx = np.full(len(pts), NO_AREA, dtype=np.uint16)
    j = gpd.sjoin(pts, gdf[["id", "geometry"]], how="left", predicate="within"); j = j[~j.index.duplicated(keep="first")]
    ok = j["id"].notna().values; idx[j["i"].values[ok]] = j["id"].values[ok].astype(np.uint16)
    miss = np.nonzero(idx == NO_AREA)[0]
    if len(miss):
        n = gpd.sjoin_nearest(pts.iloc[miss].to_crs(3857), gdf[["id", "geometry"]].to_crs(3857), how="left", max_distance=1000)
        n = n[~n.index.duplicated(keep="first")]; okn = n["id"].notna().values
        idx[n["i"].values[okn]] = n["id"].values[okn].astype(np.uint16)
    return idx


def as_ratio(series):
    s = pd.to_numeric(series, errors="coerce")
    return s / 100.0 if s.median() > 1.5 else s


AGE_BANDS = {"0_14": ["0-4", "5-9", "10-14"], "15_24": ["15-19", "20-24"], "25_34": ["25-29", "30-34"], "35_44": ["35-39", "40-44"],
             "45_54": ["45-49", "50-54"], "55_64": ["55-59", "60-64"], "65_plus": ["65-69", "70-74", "75-79", "80-84", "85+"]}
ETH = ["bumi_malay", "bumi_other", "chinese", "indian", "other_citizen", "other_noncitizen"]


def build_districts(work, out, pts, rep, owner, repo):
    """Census-based population by district (DOSM population_district): ethnicity and age shares."""
    pdist, u = get_table("population_district", "population")
    rep["demo_sources"] = [u]
    pdist["date"] = pd.to_datetime(pdist["date"]); years = sorted(pdist["date"].dt.year.unique())
    year = 2025 if 2025 in years else max(years)
    d = pdist[pdist["date"].dt.year == year].copy()
    d["_state"] = d["state"].map(norm_state); d["_dist"] = d["district"].map(norm)
    tot = d[(d.sex == "both") & (d.age == "overall") & (d.ethnicity == "overall")].set_index(["_state", "_dist"])["population"]
    eth = d[(d.sex == "both") & (d.age == "overall") & (d.ethnicity.isin(ETH))].pivot_table(index=["_state", "_dist"], columns="ethnicity", values="population", aggfunc="sum")
    age = d[(d.sex == "both") & (d.ethnicity == "overall") & (d.age != "overall")].pivot_table(index=["_state", "_dist"], columns="age", values="population", aggfunc="sum")
    rep["demo"] = {"year": int(year), "years_available": [int(y) for y in years], "age_labels": sorted(map(str, age.columns)), "eth_labels": sorted(map(str, eth.columns)), "districts_in_table": int(len(tot))}
    missing_age = [a for b in AGE_BANDS.values() for a in b if a not in age.columns]
    if missing_age:
        raise RuntimeError(f"population_district age labels not as expected; missing {missing_age}; found {list(age.columns)}")
    g = read_geo(owner, repo, "datasets/geodata/administrative_2_district.geojson", work)
    sc, dc = pick_col(g.columns, "state", "negeri"), pick_col(g.columns, "district", "daerah")
    g = g.assign(_state=g[sc].map(norm_state), _dist=g[dc].map(norm), _name=g[dc].astype(str))[["_state", "_dist", "_name", "geometry"]].reset_index(drop=True)
    g["id"] = np.arange(len(g))
    table, matched = [], 0
    for r in g.drop(columns="geometry").to_dict("records"):
        k = (r["_state"], r["_dist"]); rec = {"id": int(r["id"]), "state": r["_state"], "name": r["_name"], "year": int(year)}
        if k in tot.index and tot[k] > 0:
            T = float(tot[k]); matched += 1
            rec["eth"] = {e: round(float(eth.loc[k, e]) / T, 5) if e in eth.columns and k in eth.index and pd.notna(eth.loc[k, e]) else None for e in ETH}
            rec["age"] = {b: round(float(sum(age.loc[k, a] for a in ages)) / T, 5) for b, ages in AGE_BANDS.items()}
            rec["wa"] = round(sum(rec["age"][b] for b in ("15_24", "25_34", "35_44", "45_54", "55_64")), 5)
        table.append(rec)
    rep["demo"].update({"district_polygons": len(g), "districts_matched": matched,
                        "unmatched": [t["state"] + " / " + t["name"] for t in table if "eth" not in t][:20]})
    if matched / len(g) < 0.95:
        raise RuntimeError(f"Only {matched}/{len(g)} district polygons matched population_district: {rep['demo']['unmatched']}")
    didx = assign_points(pts, g)
    rep["demo"]["cells_without_district"] = int((didx == NO_AREA).sum())
    json.dump({"year": int(year), "districts": table}, open(os.path.join(out, "districts.json"), "w"), separators=(",", ":"))
    g[["id", "geometry"]].to_file(os.path.join(work, "districts_full.geojson"), driver="GeoJSON")
    return didx, int(year)


def build_econ(work, out, lon, lat, report):
    import geopandas as gpd
    rep = report.setdefault("econ", {})

    # ---- tables
    inc_dun, u1 = get_table("hh_income_dun"); exp_dun, u2 = get_table("hh_expenditure_dun")
    inc_par, u3 = get_table("hh_income_parlimen"); exp_par, u4 = get_table("hh_expenditure_parlimen")
    lfs_dun, u7 = get_table("lfs_dun", "lfs"); lfs_par, u8 = get_table("lfs_parlimen", "lfs")
    lfs_dun, ly1 = latest(lfs_dun, []); lfs_par, ly2 = latest(lfs_par, [])
    for t in (lfs_dun, lfs_par):
        t["p_rate"] = as_ratio(t["p_rate"]); t["u_rate"] = as_ratio(t["u_rate"])
    rep["lfs"] = {"years": {"dun": ly1, "parlimen": ly2}, "columns": list(lfs_dun.columns), "sources": [u7, u8],
                  "p_rate_range": [float(lfs_dun.p_rate.min()), float(lfs_dun.p_rate.max())], "u_rate_range": [float(lfs_dun.u_rate.min()), float(lfs_dun.u_rate.max())]}
    rep["sources"] = [u1, u2, u3, u4]
    inc_dun, y1 = latest(inc_dun, ["income_median"]); exp_dun, y2 = latest(exp_dun, ["expenditure"])
    inc_par, y3 = latest(inc_par, ["income_median"]); exp_par, y4 = latest(exp_par, ["expenditure"])
    rep["years"] = {"income_dun": y1, "expenditure_dun": y2, "income_parlimen": y3, "expenditure_parlimen": y4}
    rep["columns"] = {"income_dun": list(inc_dun.columns), "expenditure_dun": list(exp_dun.columns)}

    hh, u5 = get_table("hh_profile_state", "households")
    pop, u6 = get_table("population_state", "population")
    rep["sources"] += [u5, u6]
    hh["date"] = pd.to_datetime(hh["date"]); pop["date"] = pd.to_datetime(pop["date"])
    for c, v in (("sex", "both"), ("age", "overall"), ("ethnicity", "overall")):
        if c in pop.columns:
            pop = pop[pop[c] == v]
    years = sorted(set(hh["date"]) & set(pop["date"]))
    if not years:
        raise RuntimeError("No common year between households and population tables")
    hy = max(years)
    hs = (pop[pop.date == hy].set_index("state")["population"] / hh[hh.date == hy].set_index("state")["households"]).dropna()
    hs.index = [norm_state(s) for s in hs.index]
    # DOSM population_state is published in thousands ('000) while hh_profile_state counts households:
    # detect the scale from the ratio instead of assuming it, and record it.
    med = float(hs.median()); scale = 1.0
    if med < 0.02: scale = 1000.0
    elif med > 2000: scale = 0.001
    hs = hs * scale
    rep["household_size_unit_fix"] = f"population x {scale:g} (raw median ratio {med:.5f})"
    rep["household_size_year"] = int(hy.year); rep["household_size_by_state"] = {k: round(float(v), 3) for k, v in hs.items()}
    if not hs.between(2.0, 7.0).all():
        raise RuntimeError(f"Implausible household sizes (unit mismatch?): {hs.to_dict()}")

    # ---- boundaries
    owner, repo, pdun, ppar = find_boundaries(rep)
    rep["boundaries"] = {"repo": f"{owner}/{repo}", "dun": pdun, "parlimen": ppar}
    gd = read_geo(owner, repo, pdun, work); gp = read_geo(owner, repo, ppar, work)
    rep["boundary_columns"] = {"dun": [c for c in gd.columns if c != "geometry"], "parlimen": [c for c in gp.columns if c != "geometry"]}
    sd, dd, pd_ = pick_col(gd.columns, "state", "negeri"), pick_col(gd.columns, "dun"), pick_col(gd.columns, "parlimen", "parliament")
    sp, pp = pick_col(gp.columns, "state", "negeri"), pick_col(gp.columns, "parlimen", "parliament")
    if not all([sd, dd, sp, pp]):
        raise RuntimeError(f"Boundary columns not recognised: {rep['boundary_columns']}")

    def keyed(df, scol, ncol, kind):
        d = df.copy(); d["_state"] = d[scol].map(norm_state); d["_code"] = d[ncol].map(lambda s: code_of(s, kind))
        return d

    gd = keyed(gd, sd, dd, "N"); gp = keyed(gp, sp, pp, "P")
    gd = gd.assign(_gname=gd[dd].astype(str), _gpar=(gd[pd_].astype(str) if pd_ else ""))[["_state", "_code", "_gname", "_gpar", "geometry"]]
    gp = gp.assign(_gname=gp[pp].astype(str), _gpar=gp[pp].astype(str))[["_state", "_code", "_gname", "_gpar", "geometry"]]
    idun = keyed(inc_dun, "state", "dun", "N").merge(keyed(exp_dun, "state", "dun", "N")[["_state", "_code", "expenditure"]], on=["_state", "_code"], how="left")
    ipar = keyed(inc_par, "state", "parlimen", "P").merge(keyed(exp_par, "state", "parlimen", "P")[["_state", "_code", "expenditure"]], on=["_state", "_code"], how="left")
    idun = idun.merge(keyed(lfs_dun, "state", "dun", "N")[["_state", "_code", "p_rate", "u_rate"]], on=["_state", "_code"], how="left")
    ipar = ipar.merge(keyed(lfs_par, "state", "parlimen", "P")[["_state", "_code", "p_rate", "u_rate"]], on=["_state", "_code"], how="left")
    cols = ["_state", "_code", "_hname", "_hpar", "income_mean", "income_median", "expenditure", "p_rate", "u_rate"]
    idun = idun.rename(columns={"dun": "_hname", "parlimen": "_hpar"})[cols]
    ipar = ipar.assign(_hname=ipar["parlimen"], _hpar=ipar["parlimen"])[cols]
    a_dun = gd[~gd["_state"].isin(FT)].merge(idun, on=["_state", "_code"], how="left")
    a_ft = gp[gp["_state"].isin(FT)].merge(ipar, on=["_state", "_code"], how="left")
    a_dun["level"] = "dun"; a_ft["level"] = "parlimen"
    for a in (a_dun, a_ft):
        a["area_name"] = a["_hname"].fillna(a["_gname"]); a["parlimen_name"] = a["_hpar"].fillna(a["_gpar"])
    areas = pd.concat([a_dun, a_ft], ignore_index=True)
    areas = gpd.GeoDataFrame(areas, geometry="geometry", crs=4326)
    matched = areas["income_median"].notna()
    rep["areas"] = {"dun_polygons": int((areas.level == "dun").sum()), "ft_parlimen_polygons": int((areas.level == "parlimen").sum()),
                    "matched_income": int(matched.sum()), "matched_expenditure": int(areas["expenditure"].notna().sum()),
                    "matched_lfs": int(areas["p_rate"].notna().sum()),
                    "unmatched_examples": areas.loc[~matched, ["_state", "area_name"]].head(15).values.tolist()}
    if matched.mean() < 0.95:
        raise RuntimeError(f"Only {matched.mean():.1%} of areas matched HIES income rows: {rep['areas']}")
    areas["hh_size"] = areas["_state"].map(hs)
    if areas["hh_size"].isna().any():
        raise RuntimeError("Missing household size for states: " + str(sorted(set(areas.loc[areas.hh_size.isna(), "_state"]))))
    areas = areas.reset_index(drop=True); areas["id"] = np.arange(len(areas))

    # ---- assign each population cell to the area containing its centre
    pts = gpd.GeoDataFrame({"i": np.arange(len(lon))}, geometry=gpd.points_from_xy(lon, lat), crs=4326)
    area_idx = assign_points(pts, areas)
    rep["cells_with_area"] = int((area_idx != NO_AREA).sum()); rep["cells_without_area"] = int((area_idx == NO_AREA).sum())
    district_idx, demo_year = build_districts(work, out, pts, rep, owner, repo)

    # ---- outputs
    def num(v):
        return None if pd.isna(v) else float(v)
    table = [{"id": int(r["id"]), "level": r["level"], "state": r["_state"], "name": str(r["area_name"]), "parlimen": str(r["parlimen_name"] or ""),
              "income_median": num(r["income_median"]), "income_mean": num(r["income_mean"]), "expenditure_mean": num(r["expenditure"]),
              "hh_size": round(float(r["hh_size"]), 4), "p_rate": num(r["p_rate"]), "u_rate": num(r["u_rate"])} for r in areas.drop(columns="geometry").to_dict("records")]
    json.dump({"year": y1, "expenditure_year": y2, "household_size_year": int(hy.year), "lfs_year": ly1, "areas": table}, open(os.path.join(out, "areas.json"), "w"), separators=(",", ":"))
    simp = areas[["id", "geometry"]].copy(); simp["geometry"] = simp.geometry.simplify(0.0004, preserve_topology=True)
    simp.to_file(os.path.join(out, "areas.geojson"), driver="GeoJSON", COORDINATE_PRECISION=5)
    areas[["id", "geometry"]].to_file(os.path.join(work, "areas_full.geojson"), driver="GeoJSON")
    return area_idx, district_idx, {"demo_year": demo_year, "lfs_year": ly1, "year": y1, "expenditure_year": y2, "household_size_year": int(hy.year), "areas": len(table),
                      "levels": "DUN (13 states) + parliamentary constituency (3 Federal Territories)",
                      "boundaries": rep["boundaries"], "sources": rep["sources"],
                      "cells_without_area": rep["cells_without_area"]}
