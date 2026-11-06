# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.18 highlights

- OpenCode Web-inspired session tabs replace the top workspace display. Hover a
  tab for its full session name and workspace; switch between retained drafts,
  files and Agent views. Closing a tab leaves background Agent work running.
- Refreshed chat presentation with six activity-category visibility, grouping and
  disclosure controls, plus five detail presets.
- Foldable context-compaction summaries and separators, queued/running indicators,
  and complete Markdown viewing for oversized summaries.
- Distinct command, Skill and file-reference affordances; `@` file suggestions,
  removable reference chips and precise keyboard editing. New session views start
  with the right panel closed.
- All bundled Agents receive one concise instruction for Web-compatible KaTeX
  mathematical notation.

## 0.1.18 更新

- 顶部工作区展示改为 OpenCode Web 风格的会话标签，悬停显示完整会话名称与工作区；
  切换时保留草稿、文件和 Agent 视图，关闭标签后后台 Agent 继续执行。
- 全新聊天样式，支持六类活动的显示、分组和折叠控制，以及五档详细程度预设。
- 上下文压缩摘要可折叠，带分界线与排队／执行状态；超长摘要可完整查看 Markdown。
- 命令、Skill 和文件引用分开展示，支持 `@` 文件选择、引用标签及精确键盘编辑；
  新打开的会话默认收起右侧面板。
- 每个内置 Agent 增加一行简洁的 KaTeX 数学公式格式指令。

## Downloads

- Windows x64: download the `.exe` installer.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.18
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.18
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
