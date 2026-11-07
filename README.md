# Malaysia Catchment Intelligence Dashboard

Retail and coffee store location planning: population (GHS-POP via HDX), Meta Relative Wealth Index (via HDX),
and HeiGIT openrouteservice driving isochrones (1–10 minutes), on an OpenStreetMap basemap.

**Live site:** https://angcandy20-bot.github.io/MY-catchment-intelligence/

## How it is built
Every push to `main` runs `.github/workflows/deploy.yml`:
1. `pipeline/build_data.py` downloads the datasets from HDX, verifies year / version / units / CRS / resolution / NoData,
   keeps every populated 100 m cell, matches each cell to the nearest RWI sample (great-circle distance), and writes
   0.25° binary data chunks to `site/data/`.
2. `pipeline/check_samples.py` recomputes sample polygons directly from the original raster (independent method);
   `tests/check_real.mjs` compares the dashboard's calculation with it.
3. Unit tests, synthetic-data tests, and browser end-to-end tests run (HeiGIT responses are **mocked** in tests marked
   `simulated-api`).
4. The site is deployed to GitHub Pages and re-tested at the live URL. Reports are pushed to the `reports` branch and
   shown in the dashboard under *Data & method → Build & verification*.

Optional: add a repository secret `HEIGIT_API_KEY` to enable real HeiGIT API tests in CI. The key is only used by the
test browser and is never written to files.

## Privacy of the API key
The dashboard keeps the user's HeiGIT key in page memory only. It is never written to browser storage, logs or exports,
and is sent only to `https://api.heigit.org/openrouteservice/v2/isochrones/driving-car`.
