# EasyResearch Desktop

EasyResearch Desktop runs the same EasyResearch backend and Web interface as the npm CLI. It embeds the matching native EasyResearch executable, so Node and Bun are not required at runtime.

## 0.1.23 highlights

- Background subagents acknowledge accepted work before inference, accept follow-ups in the same session, and report after each busy period, including remaining work.
- Add managed local `shell` and SSH background commands with millisecond timeouts, automatic foreground-to-background promotion, owned output and completion notifications. Composer Stop interrupts the current run; task controls cancel a selected command or subagent tree.
- Add a **live command-output pane** above the composer. Inspect genuine program progress, elapsed time and terminal status; selected final output stays visible until dismissal. Closing the pane leaves the command running, and browser tabs share the existing event connection.
- Guide background programs to emit concise, flushed stage/count progress and percentages only when a real total is known. Improve cancellation, retry, child-history isolation and verified local-process handover during a planned server restart. SSH connections stop at server shutdown.
- Expand file previews with XLSX workbooks, PPTX slides, audio, video, fonts and CSV/TSV tables. Improve file-link resolution, ambiguous-path selection, line navigation and source views; Office engines and fonts are bundled locally.
- Add the **Skill marketplace** in Settings and the `@` context picker: browse, preview and install Skills into the existing global Skill resources.

## 0.1.23 更新

- 后台子智能体在任务接收后即可返回，无需等待首次模型回复；支持向同一子会话追加指令，并在每轮工作结束时汇报结果及剩余任务。
- 新增托管本地 `shell` 和 SSH 后台执行，采用毫秒超时，支持前台命令自动转入后台、输出保存和完成通知。输入框「停止」中断当前运行；任务控件可取消指定命令或子智能体任务树。
- 输入框上方新增 **实时命令输出面板**，查看程序真实进度、运行时间和结束状态；选中的最终输出会保留至关闭面板。关闭面板不影响命令执行，多个浏览器标签页共享现有事件连接。
- 工具说明要求后台程序输出简洁、及时刷新的阶段与计数进度，仅在总量明确时使用百分比。改进取消、重试、子会话隔离和计划重启时的本地进程接管；SSH 连接会在服务关闭时终止。
- 扩展 XLSX 工作簿、PPTX 幻灯片、音频、视频、字体及 CSV/TSV 表格预览；改进文件链接解析、歧义路径选择、行号定位和源码查看，Office 引擎及字体随应用打包。
- 设置及 `@` 上下文选择器新增 **Skill 市场**，支持浏览、预览并安装到已有的全局 Skill 资源目录。

## Downloads

- Windows x64: download the `.exe` installer and choose a folder in the installation wizard.
- macOS Apple silicon: download the `macos-arm64.dmg`, open it, and drag EasyResearch to Applications.
- Linux ARM64 (aarch64) with glibc: download `EasyResearch-<version>-linux-arm64.AppImage` or `EasyResearch-<version>-linux-arm64.deb` (Debian/Ubuntu), available starting with 0.1.12.
- Linux x64: use the npm CLI; its desktop build remains a development preview.

For Linux ARM64, replace the version below with the downloaded release:

```bash
version=0.1.23
chmod +x "EasyResearch-${version}-linux-arm64.AppImage"
"./EasyResearch-${version}-linux-arm64.AppImage"
```

Or install the Debian/Ubuntu package and open EasyResearch from the applications menu:

```bash
version=0.1.23
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
