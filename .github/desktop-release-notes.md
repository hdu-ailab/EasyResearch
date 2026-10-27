# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.15 highlights

- Upload multiple files into the Work workspace or a chosen folder, with progress,
  cancellation and retry. Each file may be up to 1 GiB; existing names are preserved.
- Download full files and rename files directly from the file tree. Renaming also
  updates the current view's open file tab.
- Preview images with zoom controls and play MP4 videos with seeking and fullscreen.
- Open interactive HTML reports in an isolated preview, including document-relative
  CSS, scripts and images. Dependencies must be inline or within the report folder;
  download CDN libraries alongside the report. Source view and download remain
  available. Browser codec support applies to videos; HTML previews do not host a
  backend or gain access to the EasyResearch application.

## 0.1.15 更新

- Work 文件面板支持多文件上传，可选择工作区或子目录，查看进度、取消和重试。
  单文件最大 1 GiB，同名文件会提示冲突并保留原文件。
- 支持直接下载完整文件、重命名文件，并同步更新当前页面已打开的文件标签。
- 支持图片缩放预览、MP4 播放、进度拖动和全屏。
- 支持隔离的交互式 HTML 报告预览及相对路径 CSS、脚本和图片，并可查看源码或下载。
  HTML 依赖须内嵌或置于报告目录及其子目录，CDN 库需下载到本地；视频编码支持取决于
  浏览器。HTML 预览不提供后端运行环境或主应用访问权限。

## Downloads

- Windows x64: download the `.exe` installer.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.15
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.15
sudo apt install "./EasyResearch-${version}-linux-arm64.deb"
```

If the AppImage cannot start because the host restricts unprivileged user namespaces, use the `.deb` package or restore the host's namespace support. The app requires a working sandbox.

The npm CLI also supports Linux ARM64: `npm install -g easyresearch@latest` selects the native package automatically.

The Windows installer is unsigned. The macOS app has ad-hoc integrity signatures but is not Developer ID-signed or notarized. Windows SmartScreen and macOS Gatekeeper may display a warning. On macOS, after verifying the checksum and attestation, remove quarantine with:

```bash
xattr -dr com.apple.quarantine /Applications/EasyResearch.app
```

## Verification

`SHA256SUMS` contains the checksum of each installer. Verify the downloaded file before installation:

```powershell
Get-FileHash -Algorithm SHA256 .\EasyResearch-*.exe
```

```bash
shasum -a 256 EasyResearch-*.dmg
```

```bash
sha256sum EasyResearch-*-linux-arm64.AppImage  # or the downloaded .deb
```

GitHub build-provenance attestations are also published. With the GitHub CLI installed:

```bash
gh attestation verify <downloaded-file> --repo hdu-ailab/EasyResearch
```

Updates are manual: choose **Exit** in the tray/menu bar, download the newer package from the latest GitHub Release, then replace the AppImage or install the new installer/`.deb`. Existing `~/.easyresearch/agent` state is preserved.
