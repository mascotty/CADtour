# CADtour local open-source edition

Local CAD floor-plan editing, 3D furniture placement and Blender Cycles rendering.
Code retains the upstream MIT license and attribution.

Extract the entire archive. On Windows install Python 3.10+ and Blender, then
double-click `Start-CADtour.cmd`. The default URL is `http://127.0.0.1:4180`.
Keep the console open. The tested setup uses Python 3.13 and Blender 5.2.
No pip installation or BlenderKit/MCP connection is required. Three.js is bundled
for offline use. Do not open index.html directly or use a static-only server.

`python launch.py --check` checks paths; `python launch.py --port 4181` changes ports.
Set `CADTOUR_BLENDER` if Blender is not detected. Editing works without Blender;
conversion and final rendering require it. Solid lettering currently requires Windows.

Third-party private models are excluded. The library contains procedural furniture
and one generated MIT side table with matching GLB/BLEND files. Import your own
licensed models through the asset importer. Unsupported complex FBX materials may
need repair. Standalone wall/floor texture ZIP import is not implemented yet.

Export plan JSON regularly. JSON does not embed model files; back up `assets/models`
along with plans when moving computers. The bundled catalog is `catalog.json`;
new imports go into ignored `catalog.local.json`. Browser saves are origin-specific.

See the Chinese README for detailed features and use, `THIRD_PARTY_NOTICES.md` for
licenses, and [development and release guide](docs/DEVELOPMENT.md) for validation. Run Python unit tests as documented.
GitHub Pages cannot run the Python/Blender backend. This is a loopback-only application,
not a public multi-user service.
