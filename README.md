# 拼多多评价自动回复助手

一个本地运行的拼多多商家后台评价处理工具，支持多账号顺序处理、DeepSeek 回复生成、情感风险识别、疑似差评同步飞书/企业微信，以及公司内部自动化任务托管平台接入。

## 主要功能

- 当前账号抓取近 30/90/180 天 4/5 星评价
- 多账号独立登录态、独立评价池、顺序自动回复
- 明确好评正常回复，中性评价保守回复，疑似差评跳过并同步人工处理
- 飞书多维表格记录疑似差评，企业微信/飞书群机器人按店铺汇总提醒
- 情感分析提示词可在界面配置、测试、恢复默认和 AI 优化
- 本地 Express API + SSE 进度事件
- Windows 便携文件夹 + 启动 exe 打包
- `automation-manifest.json` 支持内部自动化任务托管平台接入

## 项目结构

```text
.
├── automation-manifest.json       # 自动化托管平台动作声明
├── server/                        # Express 服务、Playwright 自动化、数据与测试
│   ├── index.js                   # 服务入口，默认端口 3001
│   ├── routes/                    # API 路由
│   ├── services/                  # 自动化、回复、情感识别、外部同步
│   ├── tests/                     # 后端测试
│   └── build.js                   # 便携版构建脚本
├── web/                           # React + Ant Design 前端
│   └── src/
└── 好评例子.txt                   # 默认好评模板示例
```

## 本地开发

安装后端依赖：

```bash
cd server
npm install
```

安装前端依赖：

```bash
cd web
npm install
```

启动后端：

```bash
cd server
npm start
```

开发前端：

```bash
cd web
npm run dev
```

生产构建：

```bash
cd server
npm run build
```

构建完成后，便携版位于：

```text
server/dist/
```

复制到其他电脑时请复制整个 `server/dist` 文件夹，不要只复制 exe。

## 配置与数据

API Key、飞书配置、企业微信 Webhook、评价数据和浏览器登录态都写入当前电脑的用户数据目录，不应提交到 GitHub。

不要提交这些内容：

- `settings.json`
- `reviews.json`
- `browser-data*`
- `server/dist`
- `node_modules`
- `.playwright-mcp`
- 真实 API Key、Webhook、飞书 App Secret

## 自动化托管平台接入

托管平台读取根目录：

```text
automation-manifest.json
```

健康检查：

```http
GET http://localhost:3001/api/health
```

进度事件：

```http
GET http://localhost:3001/api/automation/events/{jobId}
```

停止任务：

```http
POST http://localhost:3001/api/automation/stop/{jobId}
```

动作入口包括：

- `fetch_reviews_current_account`
- `reply_good_reviews_current_account`
- `reply_good_reviews_all_accounts`
- `e2e_dry_run_current_account`
- `detect_all_shop_names`

所有自动回复动作都支持 `dryRun`。登录、验证码、滑块、人机验证、账号安全验证和平台风控必须人工处理，程序不会绕过平台安全机制。

## 验证命令

后端测试：

```bash
cd server
npm test
```

前端 lint：

```bash
cd web
npm run lint
```

前端构建：

```bash
cd web
npm run build
```

便携版构建：

```bash
cd server
npm run build
```

## 安全说明

建议 GitHub 仓库设为私有仓库。项目包含针对拼多多商家后台的自动化逻辑，虽然源码不包含账号密码和 API Key，但仍属于内部运营工具，不建议公开发布。
