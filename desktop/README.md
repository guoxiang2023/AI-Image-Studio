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
npm run desktop:build:mac     # macOS x64 + arm64，dmg/zip
npm run desktop:build:win     # Windows x64，nsis/zip
```

macOS 上也可以交叉构建 Windows 包；若本机 electron-builder 工具链缺少依赖，改用 Windows 机器或 Windows CI。产物输出到 `dist/`。

## 数据目录

- macOS：`~/Library/Application Support/Luma/data`
- Windows：`%APPDATA%\Luma\data`

会话 Cookie、登录状态和窗口数据保存在 Electron 的 `userData` 目录；删除该目录会重置桌面端本地数据。

彻底改名后，Luma 使用全新的 `userData` 目录；旧的 `~/Library/Application Support/画境` 不会被读取、复制或删除，需要时请手动备份或清理。

## 自动更新

桌面端通过 `electron-updater` 读取 GitHub Release 中的 `latest-mac.yml` / `latest.yml`。检测到新版本后，点击「下载并安装」会在应用内下载；下载完成后再次点击「重启并安装」。

发布新版本时必须同时上传：

- macOS：`Luma-<version>-mac-*.zip`、`latest-mac.yml`、对应的 `.blockmap`
- Windows：`Luma-<version>-win-x64.exe`、`latest.yml`、对应的 `.blockmap`

自动更新依赖正式签名：

- macOS 必须使用 Developer ID Application 签名并完成 notarization；ad-hoc 签名只能保证启动，不能可靠完成 Squirrel.Mac 更新。
- Windows 建议使用代码签名证书，否则安装和更新可能触发 SmartScreen。
- 未满足签名条件时，下载失败会保留「前往下载」的手动下载入口。

## 分发注意

构建脚本默认复用本机可用的 macOS 签名证书；如果本机没有证书，`afterPack` 会做 ad-hoc 签名，保证 arm64 包可以启动。

正式分发仍需要：

- macOS：Developer ID Application 证书 + notarization；仅 ad-hoc 或 Apple Development 签名会被 Gatekeeper 拒绝。
- Windows：代码签名证书；未签名安装包会触发 SmartScreen。

本地构建可以设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过证书发现，使用 ad-hoc 签名。
