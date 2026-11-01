# Luma · AI Image Studio

对话式图片生成智能体。配置自己的对话模型和图片模型后，用自然语言生成、修改和管理图片；同时提供 Web、Docker 和 Electron 桌面端。

## 功能

- 多轮图片生成与基于参考图的修改
- 提示词自动优化、会话摘要、上下文压缩
- 每个账号独立配置 LLM / 图片模型
- 图片画册、文件夹、标签、收藏、对比
- Skill 导入：把风格、约束和默认参数封装成可复用配置
- Web / Docker / macOS / Windows 桌面端

## 快速开始

要求 Node.js 22+（使用内置 `node:sqlite`）。

```bash
npm install
npm start
# http://127.0.0.1:8787
```

首次启动后注册账号，在「模型设置」中填写 LLM 和图片模型的 Base URL、模型名和 API Key。

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

完整配置见 `src/config.js` 和 `compose.yaml`。
