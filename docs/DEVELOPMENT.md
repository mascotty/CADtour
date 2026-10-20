# 开发、发布与验证

本页汇总贡献指南、发布步骤和原发布版的验证记录。日常使用请阅读 [项目说明](../README.md)。

## Contributing

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

---

## 分享与发布

### 给设计师试用

分享 `CADtour-OpenSource-20261019.zip`，让对方完整解压后阅读 README，安装 Python
及 Blender，双击 `Start-CADtour.cmd`。本机安装目录、旧方案、8 套私人模型不会随包分享。

Windows 是本版完整功能的验证平台。Python 和 Blender 安装器没有打包。
可以先不装 Blender 体验编辑；模型转换和渲染需要它。

### 上传 GitHub

将这个发布目录的内容放到目标仓库根目录，保留 `.gitignore`、`.gitattributes`、
`LICENSE` 和 `THIRD_PARTY_NOTICES.md`。使用 Git 或 GitHub Desktop 提交即可。
不要把以前的工作目录整体拖入仓库。

如果更新已有仓库，先检查已有内容和提交历史，避免覆盖他人的工作。
现有 MIT 署名必须保留；第三方纹理与依赖遵循各自许可证。

建议仓库简介：

> Local CAD floor-plan editor with 3D furniture placement, asset import and Blender Cycles rendering.

仓库发布页面可附上 ZIP 和相应 `.sha256` 文件。源代码、示例材质与几何已经随包提供；
GitHub 本身不会运行 Blender，用户按 README 在自己的电脑启动。

### 后续重新打包

发布工具只打包 `RELEASE_FILES.json` 列出的审核文件。
新增代码或允许公开的素材时，先检查内容和授权，再更新该清单。

```powershell
python tools/package_release.py --check
python tools/package_release.py
```

后来导入的用户模型、`catalog.local.json`、渲染结果和日志不会自动进入分享 ZIP。
打包工具不执行 Git 提交或上传，不会发布到任何远端。

---

## Release validation — 2026-10-19

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

### Commands

```powershell
python launch.py --check
python -m unittest test_render_server.py test_asset_import.py test_wall_text_outlines.py
python launch.py --no-browser
## In another terminal:
cd tools
npm install
npx playwright install chromium
node test_release.mjs --import --render
```

`CADTOUR_TEST_URL` changes the test server URL. `CADTOUR_TEST_BROWSER` optionally
selects an installed Chrome/Chromium executable. Browser dependencies are only
for development; end users do not need Node or npm.
