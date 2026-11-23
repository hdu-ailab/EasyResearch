# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.24 highlights

- Add **in-product updates** through the version button. Supported global npm installations can install and activate a verified update; failures provide an installation-scope-aware manual command. Windows per-user Desktop installations can download, install and restart, with the latest Release available on failure. macOS and Linux Desktop support verified downloads for manual installation.
- Improve the **Skill marketplace** with website and namespaced sources, complete supporting files, card summaries, author links and actionable installation recovery.
- Use a research-focused EasyResearch identity and shorter, consistent Agent instructions while preserving custom system prompts and role-specific capabilities.
- Remove the Windows/Linux desktop menu strip. Keep English and Chinese Windows language packs and remove unused locales, saving about **45 MiB** of installed locale files.

## 0.1.24 更新

- 点击版本号即可使用 **应用内更新**。支持的全局 npm 安装可直接安装并启用已校验的新版本，失败时提供适用于原安装位置的手动命令。Windows 当前用户桌面安装支持下载、安装和重启，失败时可打开最新 Release；macOS 和 Linux 桌面版支持下载校验后手动安装。
- 改进 **Skill 市场**：支持网站及命名空间来源、完整配套文件、卡片摘要、作者链接和安装失败恢复。
- 使用面向科研任务的 EasyResearch 身份，精简并统一各 Agent 指令，同时保留自定义系统提示词和角色权限。
- 移除 Windows/Linux 桌面菜单栏。Windows 保留中英文语言包，裁掉其余语言包，减少约 **45 MiB** 安装占用。

## Downloads

- Windows x64: download the `.exe` installer and choose a folder in the installation wizard.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.24
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.24
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
