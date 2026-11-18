# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.21 highlights

- Increase default automatic model retries to ten, with waits of 5, 10, 20, 40,
  80, then 120 seconds capped. Existing explicit retry settings take precedence.
- Add **Retry model request** for failed main, nested and custom Agents. Continue
  the retained context without sending another message or replaying completed
  tool operations; another failure starts a fresh automatic retry cycle.
- Preserve each Agent's retry status across browser reconnects and prevent stale
  responses or repeated clicks from starting duplicate recovery requests.
- Add keyless Firecrawl/Tavily web search, Firecrawl paper-index search and
  selected-page extraction, with source provenance and provider-limit handling.

Manual Retry applies to the current retained Agent session; historical errors
after the runtime has stopped do not create a new retry action.

## 0.1.21 更新

- 默认模型自动重试增加至十次，等待 5、10、20、40、80 秒，随后保持 120 秒；已有显式重试配置仍优先生效。
- 为主 Agent、嵌套子 Agent 和自定义 Agent 增加 **重试模型请求** 按钮，从保留的上下文继续，无需发送新消息或重放已完成的工具操作；再次失败会进入新一轮自动重试。
- 浏览器重连后恢复各 Agent 的重试状态，防止过期响应和重复点击启动多次恢复请求。
- 增加免密钥 Firecrawl/Tavily 网页搜索、Firecrawl 论文索引搜索及指定页面提取，保留来源信息并处理服务限额。

手动重试适用于当前仍保留的 Agent 会话；运行时已停止后的历史错误不会产生新的重试入口。

## Downloads

- Windows x64: download the `.exe` installer and choose a folder in the installation wizard.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.21
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.21
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
