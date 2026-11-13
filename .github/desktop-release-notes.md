# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.19 highlights

- The Work tab bar's plus button creates a new session in the current workspace,
  while preserving the original session's draft, files and background work.
- The Windows installation wizard now lets you choose the installation folder.
- The chat input grows and shrinks with text and font-size changes, using native
  browser sizing where available and an automatic-sizing fallback elsewhere.
- Hidden session views retain their pane choices when the window is resized.
- Home status refresh pauses while hidden and avoids overlapping slow requests.
- Improved IME confirmation, keyboard and pointer selection, active-option
  visibility, modal Tab order and file-menu focus restoration.

## 0.1.19 更新

- 在 Work 页点击标签栏加号，直接在当前工作区新建会话；原会话的草稿、
  文件视图和后台任务保持独立。
- Windows 安装向导支持选择安装目录。
- 聊天输入框随内容和字号自动伸缩，优先使用浏览器原生能力，并保留兼容方案。
- 调整窗口大小时，隐藏会话保留原来的面板选择。
- 首页隐藏后暂停状态刷新，慢请求也不会相互覆盖。
- 改善输入法确认、键鼠切换选项、列表定位、弹窗 Tab 导航及文件菜单焦点恢复。

## Downloads

- Windows x64: download the `.exe` installer and choose a folder in the installation wizard.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.19
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.19
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
