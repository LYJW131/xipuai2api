# xipuai2api

把 `https://xipuai.xjtlu.edu.cn/chat`（西浦君谋 XIPU AI）包装成 OpenAI 兼容 API：流式、工具调用、思考强度、上游模型列表透传，附带网页和终端两种实时可视化面板。

TypeScript，零运行时依赖，Node ≥ 23.6 直接运行 `.ts`（无构建步骤）。

```
src/
  server.ts    HTTP 路由、/v1/chat/completions 主流程、优雅退出
  auth.ts      UIM 登录（RSA + TOTP）→ OAuth → Jm-Token；单飞刷新 + 磁盘缓存
  upstream.ts  君谋 web API 客户端：会话、configV3 模型表、SSE 解析、重试
  sessions.ts  预热会话池 + 批量异步删除 + 启动清扫
  models.ts    上游模型目录（缓存 10 分钟，名称校验）
  protocol.ts  OpenAI ⇄ 君谋 翻译：消息拍平、工具信封、tool_calls 解析
  trace.ts     每个请求的翻译过程 trace（给面板用）
  tui.ts       终端面板
public/index.html  网页面板
```

## 运行

```bash
npm install          # 只装类型检查用的 typescript / @types/node
npm start            # node src/server.ts
npm run typecheck
npm test             # 单元测试
node test/e2e.ts     # 对运行中的网关做端到端测试（只用免费模型）
```

工具调用评测：用 `DUMP_DIR` 抓下客户端（比如 pi）的真实请求，再用 `test/tool-eval.ts` 跨模型、跨协议写法回放打分（用例的期望写在脚本里，`test/tool-variants.ts` 里是对照用的旧协议 `v1`）：

```bash
node test/tool-eval.ts <用例目录> gpt-6-luna,DeepSeek-V4.1-Flash current,v1
```

launchd：`deploy/com.xipuai.openai-proxy.plist` 里的 `__REPO__` 换成仓库路径后放进 `~/Library/LaunchAgents/`，开机自启、崩溃拉起，日志 `/tmp/xipuai-proxy.log`。

```bash
sed "s|__REPO__|$PWD|g" deploy/com.xipuai.openai-proxy.plist > ~/Library/LaunchAgents/com.xipuai.openai-proxy.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.xipuai.openai-proxy.plist
launchctl kickstart -k gui/$UID/com.xipuai.openai-proxy   # 重启（SIGTERM 时会先删掉池里的会话）
```

### 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XJTLU_ENV` | `./.env` | 凭据文件（参考 `.env.example`）：`XJTLU_USERNAME` / `XJTLU_PASSWORD` / `XJTLU_OTP_URL`（也可直接放环境变量） |
| `PORT` / `HOST` | `4620` / `127.0.0.1` | 默认只监听本机——网关花的是登录账号的积分 |
| `PROXY_API_KEY` | 空 | 设置后要求 `Authorization: Bearer …`（面板用 `?key=`） |
| `DEFAULT_MODEL` | `deepseek-v4-flash-local` | 请求没带 `model` 时使用 |
| `SESSION_POOL_SIZE` | `2` | 预热会话数 |
| `TOKEN_CACHE` | `./.token-cache.json` | Jm-Token 缓存（0600），重启不必重新 MFA 登录 |
| `DUMP_DIR` | 空 | 调试用：把每个请求的原始 JSON 存成 `<id>.json`，方便回放 |

## 端点

- `POST /v1/chat/completions`：`messages`、`stream`、`stream_options.include_usage`、`tools`、`tool_choice`、`reasoning_effort`，以及非标准的 `online: true`（上游联网搜索）
- `GET /v1/models`：上游 configV3 实时模型表，附 `free` / `score` / `thinking` / `multimodal` 字段
- `GET /v1/health`：token 有效期、会话池状态
- `GET /`：网页面板；`GET /trace/stream`（SSE）、`GET /trace/recent`：翻译过程 trace

终端面板：

```bash
node src/tui.ts            # 或 npm run tui；默认连 http://127.0.0.1:4620
```

## 翻译方式

- **消息**：上游一次只接一段文本（在它眼里是一条用户消息），于是把请求重排成：开头一句框架说明（"你是下面这段对话里的助手，对接的是用户电脑上的编码客户端"）→ `<instructions>` 里放 system/developer 消息 → `<conversation>` 里放 `User:` / `Assistant:` / `Tool result (name):` 对话稿 → 工具协议 → 最后一句"写出下一轮助手回复"。只有一条用户消息且没有工具时直接发原文。`tool` 消息按 `tool_call_id` 找回工具名。
- **工具调用**：上游没有原生 function calling，改用 `{"tool_calls":[...]}` JSON 信封。协议放在对话**之后**，紧挨生成位置，明确说明这些函数由客户端真实执行、结果会以 Tool result 回来，并且不用 `[SYSTEM]` 这类像提示词注入的标记——否则 GPT 系模型会回 "OK" 或声称"没有接入工具"。解析很宽容：整段、代码块、夹在文字里，参数写在 `arguments` / `parameters` / `args` / `input` / `function.arguments` 下或直接平铺，以及 DeepSeek 原生的 DSML 标记都能识别。`tool_choice` 支持 `none` / `required` / 指定函数。
- **流式 + 工具**：看回复第一个非空白字符——`{` 或代码块就缓冲（信封不会漏给客户端），否则直接流式输出。
- **思考强度**：`reasoning_effort` → 上游 `thinking`（none/缺省 → `minimal`，`low`/`medium`/`high` 原样，`xhigh`/`max` → `high`）。思考内容以 `reasoning_content` 返回。
- **模型**：按上游模型表校验（精确 → 忽略大小写 → 忽略 `-_` 空格），未知模型直接 404。上游对未知模型会**静默回落到付费的 gpt-6-luna**，所以必须校验。响应里的 `model` 是上游实际使用的模型。
- **usage**：上游不报 token 数，返回的是估算值（CJK 1 字≈1 token，其他 ≈4 字符/token）。

## 会话

每次调用都需要一个上游会话（`contextCount: 0`，名字 `openai-proxy`）。请求从预热池里取（池在后台逐个补充），用完交给批量删除队列，创建和删除都不在请求路径上。启动时清扫名为 `openai-proxy`、超过 1 小时没更新的残留会话（崩溃/kill -9 留下的），不会碰你自己的对话；池里的会话 30 分钟轮换一次，所以同一账号上同时跑多个网关实例也不会互相误删。

## 上游的坑（实测）

- **不是真正无状态**：君谋有账号级长期记忆，会把近期对话摘要注入到新会话里（包括经网关发出的请求）；含「记住」之类的消息会被路由到 `memory` 模型。没有 API 可以关闭或清除，网关在 trace 里标出这类改路由。
- **单次回复约 120 秒硬上限**：上游在 ~120s 时重置 HTTP/2 流。高思考强度 + 难题可能超时，网关会返回明确的错误提示。
- **限流**：并发建会话/对话会返回 "Request too fast"，"Generation failed. Please try again later" 也时有发生；只要还没向客户端输出任何内容，网关会自动退避重试。
- **登录**：code 换 token 偶发 "获取token失败"，会自动重试；token 有效期 8 小时，401/400/403 时自动重登并重放请求。

## 示例

[`demo/pelican-astra.html`](demo/pelican-astra.html)：pi 经网关调用 GPT-6-Astra 画的骑自行车的鹈鹕；[`demo/pelican-dsv41flash.html`](demo/pelican-dsv41flash.html)：用 `scripts/pelican.ts` 直接调 DeepSeek-V4.1-Flash 生成的版本。

## pi 接入

`~/.pi/agent/models.json` 里的 `xipuai` provider（`openai-completions`，`baseUrl: http://127.0.0.1:4620/v1`），`thinkingLevelMap` 把 pi 的思考档位映射到 `reasoning_effort`：

```bash
pi --model xipuai/DeepSeek-V4.1-Flash
```

## 许可证

[MIT](LICENSE)
