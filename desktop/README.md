# Luma 桌面端

桌面端用 Electron 承载现有 Node 服务，网页版代码和模型调用逻辑不变。服务只监听 `127.0.0.1` 的随机端口，数据存放在 Electron 的 `userData` 目录，不会写进安装包。

## 运行

```bash
npm install
npm run desktop
```

需要先生成 Electron 二进制。构建脚本会修正旧的 taobao 镜像地址；如需自定义镜像，设置可用的 `ELECTRON_MIRROR`。

## 打包

```bash
npm run desktop:pack          # 当前平台未打包目录，用于本地验证
npm run desktop:build:mac     # macOS x64 + arm64，dmg
npm run desktop:build:win     # Windows x64，nsis
```

macOS 上也可以交叉构建 Windows 包；若本机 electron-builder 工具链缺少依赖，改用 Windows 机器或 Windows CI。产物输出到 `dist/`。

## 数据目录

- macOS：`~/Library/Application Support/Luma/data`
- Windows：`%APPDATA%\Luma\data`

会话 Cookie、登录状态和窗口数据保存在 Electron 的 `userData` 目录；删除该目录会重置桌面端本地数据。

彻底改名后，Luma 使用全新的 `userData` 目录；旧的 `~/Library/Application Support/画境` 不会被读取、复制或删除，需要时请手动备份或清理。

## 更新

桌面端支持应用内更新：点击左下角版本号 → 「立即更新并重启」。流程是下载 Release 中与当前平台、架构匹配的安装包，校验 GitHub 提供的 SHA-256，然后静默安装并自动重启。会话、配置与图片都在 `userData` 目录，更新不会动它们。

| 平台 | 安装方式 | 说明 |
|---|---|---|
| macOS | 挂载 DMG，用 `ditto` 原地替换 `.app`，再 `open` 重启 | 只替换当前用户可写的安装位置；不可写即拒绝，改为手动安装 |
| Windows | 运行 NSIS 安装包：`/S --updated --force-run` | `--force-run` 让安装器装完自动拉起应用 |

不用 `electron-updater` / Squirrel.Mac：当前构建是 ad-hoc 签名，Squirrel 会以「code signature did not pass validation」拒绝安装。自管理更新只做「下载 + 校验 + 替换」，不依赖 Apple 公证。

细节：

- 只接受 `https` 且主机属于 GitHub 域名的安装包地址，下载被重定向到其它主机即中止。
- 不做任何提权：不会用 `osascript` 以管理员身份执行脚本，也不清除 quarantine 标记。安装位置不可写时直接拒绝并提示手动安装，避免让特权进程执行用户可写的脚本。
- 校验值来自 GitHub Release API 的 `digest`；缺失时拒绝应用内更新并引导手动下载。
- 下载先落到 `userData/updates/`，失败或校验不通过即删除，不会留下半个安装包。
- macOS 替换脚本在应用退出后运行，先把旧 bundle `mv` 成备份，`ditto` 失败则删掉半成品并 `mv` 回备份；备份无法还原时保留在 `.old.<pid>` 并记录日志。日志在 `userData/logs/updater.log`。
- 应用从 `AppTranslocation`（未拖入「应用程序」）运行时拒绝更新，避免装到一个只读的临时路径。
- 开发模式（未打包）不执行应用内更新。

## 分发注意

构建脚本默认复用本机可用的 macOS 签名证书；如果本机没有证书，`afterPack` 会做 ad-hoc 签名，保证 arm64 包可以启动。

正式分发仍需要：

- macOS：Developer ID Application 证书 + notarization；仅 ad-hoc 或 Apple Development 签名会被 Gatekeeper 拒绝。
- Windows：代码签名证书；未签名安装包会触发 SmartScreen。

本地构建可以设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过证书发现，使用 ad-hoc 签名。
