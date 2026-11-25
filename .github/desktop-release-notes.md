# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.25 highlights

- Separate **Skills**, **Skill marketplace** and **Tools** in Settings. Installed Skills use categorized cards with edit, disable/enable and delete actions.
- Load marketplace details only on demand. The plus button installs directly and becomes a checkmark after success; installation verifies discovery and refreshes the installed list immediately.
- Apply user Tool source/helper updates through the existing idle reload lifecycle. User tools default to Research Assistant; other Agents require explicit tool names.
- Show scoped extension-load failures and registration issues separately, preserving healthy tools and offering refresh recovery. Hidden tools are no longer advertised as callable.
- Fix Skill title hover feedback, action-menu dismissal and stale editor responses; align human messages consistently on the right.

## 0.1.25 更新

- 设置中拆分 **技能、技能市场、工具** 三个入口。已安装技能采用分类卡片，支持编辑、禁用/启用及删除。
- 市场详情改为按需加载，加号直接安装，成功后显示勾号；安装会核验技能发现结果，并立即刷新已安装列表。
- 自建工具源码及辅助文件的变化接入现有空闲重载机制。默认向研究助手开放，其他 Agent 通过显式工具名称授权。
- 按作用域分别显示扩展加载失败与注册问题，保留正常工具并提供刷新恢复；隐藏工具不再被误列为可调用。
- 修复技能名称悬停反馈、操作菜单误关闭和旧编辑请求覆盖问题，并统一真人消息的右侧对齐。

## Downloads

- Windows x64: download the `.exe` installer and choose a folder in the installation wizard.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.25
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.25
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
