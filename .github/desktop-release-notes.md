# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.22 highlights

- Add **Context manager**, available through `/context` and the Work page's top-right button. Inspect the main Agent's effective system prompt, user inputs, assistant replies, thinking and tools through Overview, Details and read-only raw text.
- Preview token quantities, shares and an explicitly estimated cache hit rate. Fold tool output, delete linked tool calls/results, or use existing whole-session compression. Edits affect future model context while preserving the original chat history; Apply requires idle work and a current snapshot.
- Add `/settings` and automatic first-message session titles using the Research Assistant's model. Automatic titles can be disabled in Conversation settings; manual naming takes precedence.
- Use `/` for executable actions and `@` for files and Skill context. Remove transcript edge fades for unobscured reading.
- Upgrade the agent runtime to Pi 1.6.0 with native GPT-6.2 model support. Running Agents finish their current run before applying pending configuration updates.

## 0.1.22 更新

- 新增 **上下文管理**，通过 `/context` 或工作页右上角按钮打开。按「总览 / 详情 / 原始文本」查看主 Agent 当前有效的系统提示词、用户输入、助手回复、思考和工具内容。
- 展示 Token 数量、占比及明确标注的缓存命中率预估。支持折叠工具输出、成对删除工具调用与结果，以及原有的整段会话压缩。变更影响后续模型上下文，原始聊天历史仍保留；仅在任务空闲且快照有效时应用。
- 新增 `/settings`，并使用研究助手模型根据首条消息自动生成会话标题。可在会话设置中关闭自动标题，手动命名优先。
- `/` 用于执行命令，`@` 用于引用文件和 Skill 上下文；移除聊天上下边缘的淡出遮罩。
- Agent 运行时升级至 Pi 1.6.0，原生支持 GPT-6.2 模型；正在执行的 Agent 会在当前完整运行结束后应用待更新配置。

## Downloads

- Windows x64: download the `.exe` installer and choose a folder in the installation wizard.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.22
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.22
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
