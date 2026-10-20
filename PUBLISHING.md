# 分享与发布

## 给设计师试用

分享 `CADtour-OpenSource-20261019.zip`，让对方完整解压后阅读 README，安装 Python
及 Blender，双击 `Start-CADtour.cmd`。本机安装目录、旧方案、8 套私人模型不会随包分享。

Windows 是本版完整功能的验证平台。Python 和 Blender 安装器没有打包。
可以先不装 Blender 体验编辑；模型转换和渲染需要它。

## 上传 GitHub

将这个发布目录的内容放到目标仓库根目录，保留 `.gitignore`、`.gitattributes`、
`LICENSE` 和 `THIRD_PARTY_NOTICES.md`。使用 Git 或 GitHub Desktop 提交即可。
不要把以前的工作目录整体拖入仓库。

如果更新已有仓库，先检查已有内容和提交历史，避免覆盖他人的工作。
现有 MIT 署名必须保留；第三方纹理与依赖遵循各自许可证。

建议仓库简介：

> Local CAD floor-plan editor with 3D furniture placement, asset import and Blender Cycles rendering.

仓库发布页面可附上 ZIP 和相应 `.sha256` 文件。源代码、示例材质与几何已经随包提供；
GitHub 本身不会运行 Blender，用户按 README 在自己的电脑启动。

## 后续重新打包

发布工具只打包 `RELEASE_FILES.json` 列出的审核文件。
新增代码或允许公开的素材时，先检查内容和授权，再更新该清单。

```powershell
python tools/package_release.py --check
python tools/package_release.py
```

后来导入的用户模型、`catalog.local.json`、渲染结果和日志不会自动进入分享 ZIP。
打包工具不执行 Git 提交或上传，不会发布到任何远端。
