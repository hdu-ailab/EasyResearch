# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.26 highlights

- Fix repeated Markdown/raw-text flashes in assistant and subagent output. Rendered paragraphs, tables and headings stay visible while parsing catches up, including completion and Stop.
- Add a subtle **180 ms fade-in for newly arriving assistant words**, without replaying existing text. Respect reduced-motion preferences.
- Preserve paragraph identity and selected word prefixes during streaming; keep the reading position when scrolling away from the latest output.
- Fix Mermaid recovery after incomplete streamed syntax and clear stale diagram state when content is replaced.

## 0.1.26 更新

- 修复助手与子 Agent 输出反复闪回 Markdown 源码的问题。解析过程中保持已排版的正文、表格和标题，回复结束或停止时也保持稳定。
- 助手新增词语采用 **180ms 淡入**，已有文字不重复播放动画，并适配减少动画设置。
- 保持段落节点与已输出词语的选区稳定，向上阅读时保留当前滚动位置。
- 修复 Mermaid 流式语法补全后的恢复，以及替换内容时残留旧图的问题。

## Downloads

- Windows x64: download the `.exe` installer and choose a folder in the installation wizard.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.26
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.26
sudo apt install "./EasyResearch-${version}-linux-arm64.deb"
```

If the AppImage cannot start because the host restricts unprivileged user namespaces, use the `.deb` package or restore the host's namespace support. The app requires a working sandbox.

The npm CLI also supports Linux ARM64: `npm install -g easyresearch@latest --registry=https://registry.npmjs.org/` selects the native package automatically.

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

Click the version button for update controls. Installation/restart stops active work after confirmation. If Desktop installation is unavailable or fails, open the latest Release; a verified manual download can also be revealed in the file manager. Existing `~/.easyresearch/agent` state is preserved.

Clients on 0.1.23 or earlier need one manual upgrade to gain these controls. For npm, upgrade the package and launch `easyresearch` again.
