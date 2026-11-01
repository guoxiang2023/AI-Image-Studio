# 架构

## 目标

- 传输、业务、领域、数据、外部服务分离，避免路由直接操作数据库。
- 功能按领域而不是按文件类型堆积；新增模型、工具或接口时只改对应层。
- 前端模块依赖单向、可预测；页面功能不直接互相读写内部状态。

## 后端分层

```text
HTTP (src/http)
  -> Services (src/services)
      -> Domain (src/domain)
      -> Data repositories (src/data/repositories)
      -> AI / Media (src/ai, src/media)
  -> Shared (src/shared)
```

依赖方向固定向下，禁止反向依赖：

| 层 | 职责 | 允许依赖 |
|---|---|---|
| `http` | 解析请求、SSE、状态码、路由 | services、domain、shared |
| `services` | 用例编排、权限外的业务规则、事务边界 | domain、data、ai、media、shared |
| `domain` | 纯校验、序列化、提示词片段 | config、shared |
| `data` | SQLite Schema、Repository、行到对象的持久化 | database、shared |
| `ai` | LLM 请求、提示词模板、超时与重试 | domain、shared、config |
| `media` | 文件存储、PNG 尺寸/填充 | shared、config |
| `bootstrap` | 初始化数据库、密钥、HTTP Server | 所有基础设施模块 |
| `shared` | 与业务无关的工具 | 无业务依赖 |

### 目录

```text
src/
  bootstrap/start-server.js       # DB、密钥、Server 生命周期
  config.js                       # 环境变量与常量
  http/
    create-app.js                 # 组合根：中间件 + 路由表
    router.js                     # 方法/路径匹配
    responses.js                  # JSON、请求体、安全头
    static.js                     # Web 静态资源和图片文件
    routes/                       # 只做 HTTP 适配
  auth/
    crypto.js                     # scrypt、Token、SecretBox
    session-service.js            # Session 签发、Cookie、当前用户
  services/
    auth-service.js               # 注册、登录、限流
    chat-service.js               # 会话持久化
    chat-turn-service.js          # 一轮对话的完整用例
    agent-service.js              # LLM 工具调用循环
    tools-service.js              # generate_image / edit_image
    summary-service.js            # 会话摘要压缩
    model-settings-service.js     # 模型配置读取/加密/脱敏
    model-probe-service.js        # 模型列表和连通性测试
    gallery-service.js            # 画册用例
    image-service.js              # 生成图片登记
    skill-service.js              # Skill CRUD
  data/
    database.js                   # 连接、Schema、迁移、回填
    repositories/                 # 按聚合拆分的 SQL
  domain/
    chat.js                       # 会话文档、LLM 历史、客户端视图
    chat-options.js               # 画幅/数量/参考图/标签校验
    skill.js                      # Skill 规范化和系统提示词
  ai/
    llm.js                        # Chat/Image 请求与提示词优化
    prompts.js                    # 系统提示词和工具 Schema
  media/
    image-storage.js              # 文件路径、读写、尺寸探测
    png.js                        # PNG 编码/解码/比例填充
  shared/
    errors.js                     # AppError 与 HTTP 语义错误
    utils.js                      # 通用工具
    runtime.js                    # 启动期密钥/假密码哈希
    rate-limit.js
    cookies.js
```

## 请求流程

```text
req
 -> create-app: 安全头 / Origin 校验 / 静态资源
 -> router.match
 -> 公开路由 或 读取 Session 用户
 -> route handler
 -> service
 -> repository / domain / ai / media
 -> JSON 或 SSE
```

错误约定：

- Service 业务错误抛出 `AppError(status, message)`。
- `create-app` 统一转换为 `{ error }`；`SyntaxError` -> 400，超大请求 -> 413，未知错误 -> 500。
- 限流错误携带 `retryAfter`，统一写入 `Retry-After`。

## 一轮对话

```text
POST /api/chat
  -> chat-turn-service.prepareChatTurn
       校验消息/模型配置/Skill/参考图/生成参数
       加载或创建会话
  -> route 建立 SSE、AbortController、心跳
  -> chat-turn-service.runPreparedTurn
       session 事件
       保存用户消息
       摘要压缩（可能）
       agent-service 循环调用 LLM 和 tools-service
       保存助手消息和图片
       done / error 事件
```

SSE 生命周期留在 `http`；会话保存、摘要、工具编排留在 `services`。

## 前端分层

```text
app.js
 -> bootstrap/boot.js
      -> bootstrap/events.js
      -> features/*
           -> core/index.js
                -> api / dom / state / theme / ui
```

- `core` 只提供跨功能基础设施，不依赖任何 feature。
- `features` 之间只通过导出的公开函数交互，例如 `openLightbox`、`setPrimaryReference`。
- `bootstrap/events.js` 是唯一集中绑定 DOM 事件的地方。
- 图片/会话等业务状态集中在 `core/state.js`，避免散落在模块私有变量。

## 扩展指南

### 新增 API

1. 在 `src/data/repositories/*` 增加 SQL 函数（需要持久化时）。
2. 在 `src/services/*` 增加业务函数，不直接写 HTTP 状态码。
3. 在 `src/http/routes/*` 增加薄适配器。
4. 在 `src/http/create-app.js` 注册路由。
5. 在 `test/` 增加 repository/domain 测试，并跑完整生成烟测。

### 新增图片模型能力

- 请求格式差异放在 `ai/llm.js` 或新建 `ai/providers/`。
- 业务工具参数仍由 `services/tools-service.js` 管理。
- 新增能力不要污染 `http/routes`。

### 新增前端功能

1. 在 `public/js/features/` 新建模块。
2. 从 `core/index.js` 取状态和通用 UI。
3. 在 `bootstrap/events.js` 绑定入口。
4. 不在 feature 内直接改其他 feature 的 DOM 或私有变量。

## 测试策略

- `test/domain.test.js`：纯校验、序列化、提示词片段。
- `test/data.test.js`：Repository 的 CRUD、用户隔离、持久化字段。
- 端到端：启动服务 + mock 模型，验证注册、配置、生成、画册、Skill、会话删除和桌面端加载。
