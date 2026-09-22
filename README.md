# Atlas Explorer

A no-upload, read-only GeoJSON exploration dashboard. It is designed for an administrator to update the catalogue files while users search, filter, explore, and inspect map features.

## Run locally

Serve this folder with any static-file server (rather than opening `index.html` directly), for example:

```powershell
cd C:\Users\bwirayesu\Documents\Codex\2026-09-22\390405
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Update the catalogue

1. Put each admin-approved GeoJSON file in `data/`, or zip the `.shp`, `.shx`, `.dbf`, and `.prj` components together and put that ZIP in `data/`.
2. Add a record to `catalogue` at the top of `app.js`, setting its filename, visible name, color, and `format` (`geojson` or `shapefile`).
3. Give each feature useful properties. `name`, `description`, `category`, and `status` are used by the experience; any other properties appear in the feature details panel.

The app accepts standard GeoJSON `Point`, `Polygon`, and `MultiPolygon` features, and zipped shapefiles. For shapefiles, keep the matching `.shp`, `.shx`, `.dbf`, and `.prj` components together in the ZIP.
