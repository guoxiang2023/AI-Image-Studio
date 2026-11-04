# Luma · AI Image Studio

对话式 AI 助手，支持自然对话与图片生成。配置自己的对话模型和图片模型后，用自然语言聊天、生成、修改和管理图片；同时提供 Web、Docker 和 Electron 桌面端。

## 功能

- 自然对话、流式回复与 Markdown 渲染
- 流式回复中断或刷新页面后保留已生成的部分内容
- 多轮图片生成与基于参考图的修改
- 风格参考图生成：风格图只影响画风，不污染主体、构图和文字
- 提示词自动优化、会话摘要、上下文压缩
- 会话归档：归档后进入「已归档」，可查看并恢复；归档会话只读，恢复后继续对话
- 版本检查更新、发布说明与安装包下载入口
- 每个账号独立配置 LLM / 图片模型；对话模型支持 OpenAI 兼容与 Anthropic Messages 接口，并可设置 low / medium / high / xhigh / max 推理等级；图片模型支持 auto / low / medium / high / xhigh / max 质量等级及默认值
- 模型 API Key 支持显示 / 隐藏
- 图片画册、文件夹、标签、收藏、对比
- 风格灵感库：16 个带本地预览图的精选风格预设，附来源署名；预览仅供参考，套用会覆盖风格与画幅并保留主体和文字，可叠加在模板上
- AI 风格生成：内置 10 张运营参考图库（Banner、海报、弹窗、封面、信息流、启动页），也可上传自己的参考图；默认保留参考版式与视觉语言，替换主标题、卖点、按钮、规则和二维码，并提供「画面主体」输入框，默认替换参考图中的商品、饮料、人物等主体，避免只换文案不换主体
- AI 生成结果保留模型原图比例；平台要求固定像素时，可下载后等比缩放，避免直接裁切破坏文案
- Web / Docker / macOS / Windows 桌面端

## 快速开始

要求 Node.js 22+（使用内置 `node:sqlite`）。

```bash
npm install

# 后台启动 Web（默认）
./start-web.sh start

# 查看状态 / 停止 / 重启
./start-web.sh status
./start-web.sh stop
./start-web.sh restart

# 查看日志
./start-web.sh logs 100
./start-web.sh logs -f

# 前台运行，Ctrl+C 停止
./start-web.sh run
# http://127.0.0.1:8787
```

后台运行的 PID、日志在 `.run/`。首次启动后注册账号，在「模型设置」中填写 LLM 和图片模型的 Base URL、模型名和 API Key。对话模型可选择 OpenAI 兼容或 Anthropic Messages 格式；Anthropic 接口地址可填写服务根地址（程序自动补 `/v1`），也可以直接填到 `/v1`，例如 `https://api.anthropic.com` 或 `https://api.anthropic.com/v1`。图片模型仍使用 OpenAI Images 兼容接口。

### Docker

```bash
docker compose up -d --build
```

### 桌面端

```bash
npm run desktop              # 开发运行
npm run desktop:build:mac    # macOS x64 + arm64
npm run desktop:build:win    # Windows x64
```

桌面端数据保存在 Electron `userData` 目录，构建与签名说明见 [desktop/README.md](desktop/README.md)。

## 目录结构

```text
src/
  bootstrap/       启动与进程生命周期
  config.js        环境配置与常量
  http/            HTTP 传输层、路由、静态文件
  auth/            密码、Token、Session
  services/        应用服务：业务编排
  data/            SQLite 连接、Schema、Repository
  domain/          纯业务模型与校验
  ai/              LLM 客户端与提示词
  studio/          内置 AI 参考图库
  media/           图片文件存储、PNG 处理
  shared/          通用工具、错误、限流、Cookie
public/js/
  core/            状态、DOM、API、主题、通用 UI
  features/        按功能拆分的页面模块
  bootstrap/       事件绑定与启动流程
  app.js           前端入口
desktop/           Electron 主进程与构建脚本
test/              Node 内置测试
```

分层规则和扩展方式见 [docs/architecture.md](docs/architecture.md)。

## 测试

```bash
npm test
```

## 配置

常用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录 |
| `ALLOW_REGISTRATION` | `1` | 是否开放注册 |
| `REGISTRATION_CODE` | 空 | 注册邀请码 |
| `COOKIE_SECURE` | `0` | HTTPS 下设为 `1` |
| `TRUST_PROXY` | `0` | 反向代理后设为 `1` |
| `PROMPT_OPTIMIZE` | `1` | 是否优化图片提示词 |
| `LLM_TIMEOUT_SECONDS` | `300` | 非流式对话请求总超时 |
| `LLM_STREAM_IDLE_TIMEOUT_SECONDS` | `120` | 流式回复无数据时的空闲超时，收到新内容会重置 |
| `UPDATE_REPO` | `guoxiang2023/AI-Image-Studio` | GitHub 仓库（`owner/repo`），用于检查 Release |
| `UPDATE_TIMEOUT_SECONDS` | `8` | 检查更新请求超时 |
| `UPDATE_CACHE_SECONDS` | `600` | 更新检查缓存时间 |
| `GITHUB_TOKEN` | 空 | 可选；GitHub API 限流时提高额度 |

完整配置见 `src/config.js` 和 `compose.yaml`。

## 风格预览署名

风格灵感库中的前 12 个插画/平面/国风/实验类预览图和风格特征参考自 [handraw-style](https://github.com/yang0/handraw-style)（作者 yang0，MIT with attribution）。另外 4 个产品、生活方式、人像和时装摄影预览由 Luma 使用配置的图片模型生成，风格描述由 Luma 编写；原始项目许可见 `public/assets/presets/LICENSE-handraw-style.txt`。
