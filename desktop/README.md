# 画境桌面端

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

- macOS：`~/Library/Application Support/画境/data`
- Windows：`%APPDATA%\画境\data`

会话 Cookie、登录状态和窗口数据保存在 Electron 的 `userData` 目录；删除该目录会重置桌面端本地数据。

## 分发注意

构建脚本默认复用本机可用的 macOS 签名证书；如果本机没有证书，`afterPack` 会做 ad-hoc 签名，保证 arm64 包可以启动。

正式分发仍需要：

- macOS：Developer ID Application 证书 + notarization；仅 ad-hoc 或 Apple Development 签名会被 Gatekeeper 拒绝。
- Windows：代码签名证书；未签名安装包会触发 SmartScreen。

本地构建可以设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过证书发现，使用 ad-hoc 签名。
