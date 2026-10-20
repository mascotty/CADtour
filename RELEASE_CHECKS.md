# Release validation — 2026-10-19

This is the local open-source edition, prepared separately from the private workspace.

Test environment: Windows, Python 3.13.14, Blender 5.2.2 LTS, Chrome with an isolated
Playwright browser profile. Browser tests block external HTTP(S) requests.

Completed checks:

- 38 Python unit/HTTP tests passed, including upload boundaries, path validation,
  atomic publication, native-model validation and Windows font outlines.
- Startup dependency check passed; loopback server is available on port 4180.
- Bundled Three.js loads the default procedural scene without external requests.
- Fictional DXF example imports as 13 recognized wall segments and 2 rooms.
- The generated side-table GLB loads and exports its native-model metadata.
- A second copy was uploaded through the UI, converted by Blender, previewed and
  published. Public `catalog.json` remained byte-for-byte unchanged; the imported
  entry was written to `catalog.local.json`.
- Real Cycles render completed at 512 x 495, with 64 samples on CUDA GPU.
  The native model loader replaced 5 web meshes with 5 original BLEND meshes
  (490 polygons). No native-model warning was reported.
- The resulting image was visually inspected: table geometry, floor contact and
  materials appear correctly. See `docs/demo-cycles.png`.
- Browser validation reported zero JavaScript page errors and zero external requests.
- Release files exclude private models, customer drawings, original FBX archives,
  render history, import history, user catalog and Python cache.

These checks verify this environment and representative workflows, not all CAD
dialects, GPUs, Blender versions or third-party model materials.

The test assets and runtime logs were moved outside the public directory.
`tools/test_release.mjs --import --render` reproduces the integration check; it
creates local runtime files and an additional test model, so use a disposable copy.

## Commands

```powershell
python launch.py --check
python -m unittest test_render_server.py test_asset_import.py test_wall_text_outlines.py
python launch.py --no-browser
# In another terminal:
cd tools
npm install
npx playwright install chromium
node test_release.mjs --import --render
```

`CADTOUR_TEST_URL` changes the test server URL. `CADTOUR_TEST_BROWSER` optionally
selects an installed Chrome/Chromium executable. Browser dependencies are only
for development; end users do not need Node or npm.
