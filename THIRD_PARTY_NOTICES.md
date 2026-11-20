# 第三方组件与许可证

Luma（`luma-image-agent`）在运行时分发以下第三方组件。所有组件均以目标平台原生模块、WASM 或纯 JavaScript 形式随应用打包。

## 运行时依赖

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| `sharp` | 0.35.x | Apache-2.0 | 图像解码、缩放、编码 |
| `@img/sharp-*` | 随 sharp | Apache-2.0 | sharp 的平台原生库 |
| `@napi-rs/canvas` | 0.1.x | MIT | PDF 页面栅格化 |
| `pdfjs-dist` | 4.10.x | Apache-2.0 | PDF 解析与渲染 |
| `pdfkit` | 0.20.x | MIT | 生成 PDF 文档 |
| `qrcode-generator` | 2.x | MIT | 二维码生成 |
| `dwgdxf` | 2.0.1 | MIT | DWG → DXF 转换（WASM） |
| `tesseract.js` | 7.x | Apache-2.0 | 扫描件 OCR（Windows/Linux 及 Vision 不可用时） |
| `tesseract.js-core` | 随 tesseract.js | Apache-2.0 | tesseract WASM 运行时 |
| `@tesseract.js-data/chi_sim` | 1.0.0 | Apache-2.0 | 简体中文识别语料 |

## OCR 说明

- **macOS**：优先使用系统自带的 Vision 框架（`VNRecognizeTextRequest`），由 `desktop/ocr-helper.swift` 编译成 `build/ocr/ocr-helper-<arch>` 随应用分发。使用的是操作系统 API，不额外分发模型。
- **Windows / Linux 及其他情况**：回退到随应用打包的 `tesseract.js`（WebAssembly），中文语料为 `chi_sim`。该路径完全离线，无需系统安装 tesseract。
- 识别结果只写入本机用户数据目录，不发送到任何第三方服务。

## MPL-2.0 组件声明

`dwgdxf` 的 WASM 二进制内嵌了 **`acadrust` 0.4.0**，该 Rust crate 以 **Mozilla Public License 2.0（MPL-2.0）** 发布，而非其上游 README 所称的 MIT。

- 上游来源：<https://github.com/hakanaktt/acadrust>
- 具体版本：`acadrust 0.4.0`（crates.io 页面标注 `license = "MPL-2.0"`）
- 本应用**未修改** `acadrust` 源码，直接使用 crates.io 上发布的原版 crate 编译产物。

### MPL-2.0 合规说明

MPL-2.0 是**文件级**弱 copyleft 许可。它允许将组件与专有代码组合分发，条件是：

1. 保留原始版权与许可证声明（本文件）。
2. 若修改了 MPL-2.0 覆盖的源文件，需公开这些修改后的文件。

本应用未修改 `acadrust` 的任何源文件，因此不产生公开修改的义务。`acadrust` 的完整源代码可通过以下方式获取：

```bash
# 精确版本源码（与内嵌 WASM 一致）
curl -L https://crates.io/api/v1/crates/acadrust/0.4.0/download -o acadrust-0.4.0.crate
tar -xf acadrust-0.4.0.crate
```

或从上游仓库获取：

```bash
git clone https://github.com/hakanaktt/acadrust
git checkout <对应 0.4.0 的标签>
```

`MPL-2.0` 许可证全文：<https://www.mozilla.org/en-US/MPL/2.0/>

## 开发依赖

测试与打包使用的 `electron`、`electron-builder`、`jsqr`、`dxf-writer` 等仅存在于开发环境，不随应用分发。

## 报告问题

如对本节声明有疑问，请通过仓库 Issue 联系维护者。