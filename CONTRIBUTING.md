# Contributing

Keep changes scoped and preserve web/Cycles layout agreement. Document units
(plan millimetres, Blender metres) and test asset IDs, transforms and materials.

Run `python -m unittest test_render_server.py test_asset_import.py test_wall_text_outlines.py`.
Windows is required for GDI text tests. For browser validation install the exact
Playwright version in `tools/package.json`, install Chromium with Playwright, and
follow `tools/test_release.mjs`. Browser checks must use isolated storage.

Do not commit `.renders`, `.asset-imports`, browser state, uploaded models, API keys
or customer drawings. Keep upstream attribution and dependency licenses. Before
adding assets, record their origin and redistribution license; a purchase or free
download alone does not establish permission to distribute source models.

For a bug report include OS, Python/Blender versions, steps, and a minimal synthetic
reproduction. Share real customer projects only with permission and remove identifying data.

This release uses `RELEASE_FILES.json` as a publication allowlist. When intentionally
adding public files, review their licenses/content and update the list. Run
`python tools/package_release.py --check` before creating a ZIP.
