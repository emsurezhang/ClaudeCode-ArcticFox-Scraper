# 社交媒体内容刮削 API 服务器

支持多平台的可扩展 API 服务器，通过插件机制实现动态热加载。

## 功能特性

- **插件化架构**：每个平台作为独立插件，支持动态热加载
- **平台支持**：YouTube、抖音（音频+字幕）、X/Twitter
- **Cookies 缓存**：从系统浏览器提取的 cookies 自动缓存，失效后重新获取
- **可配置认证**：API Token 可选，为空时无需认证

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 或使用热重载模式开发
npm run dev

# 调试模式 - 显示 Playwright 浏览器窗口，便于排查问题
npm start -- --debug
npm run dev -- --debug
```

服务器默认运行在 `http://localhost:3000`

**调试模式 (`--debug`)**: 在调试模式下，Playwright 打开的浏览器窗口会显示在屏幕上（非 headless 模式），操作也会放慢以便观察。这对于排查 X/Twitter 等需要 JavaScript 渲染的平台的刮削问题非常有用。

## API 端点

### 健康检查
```bash
GET /health
```

### 获取已加载插件列表
```bash
GET /api/plugins
```

### 创建刮削任务（异步）
```bash
POST /api/scrape
Content-Type: application/json

{
  "urls": [
    "https://www.youtube.com/watch?v=xxx",
    "https://x.com/claudeai"
  ],
  "options": {
    "mode": "detail",           // list=列表, detail=详情
    "scrollStrategy": "min",    // min/max/all (X/Twitter)
    "maxItems": 50,             // 列表模式最大数量
    "downloadAudio": true,
    "extractTranscript": true,
    "browser": "chrome",
    "debug": false
  }
}
```

**返回示例（HTTP 202 Accepted）：**
```json
{
  "jobId": "l3x9v1p9-qwerty",
  "status": "pending",
  "message": "Job accepted, use GET /api/jobs/:jobId to poll status"
}
```

### 查询任务状态
```bash
GET /api/jobs/:jobId
```

**返回示例：**
```json
{
  "jobId": "l3x9v1p9-qwerty",
  "status": "completed",
  "progress": { "total": 2, "done": 2 },
  "createdAt": "2026-04-19T10:00:00.000Z",
  "updatedAt": "2026-04-19T10:02:30.000Z",
  "completedAt": "2026-04-19T10:02:30.000Z",
  "results": [ { ...ScrapeResult } ],
  "errors": [ { "url": "...", "error": "..." } ]
}
```

**状态说明：**
- `pending` — 任务已创建，等待执行
- `running` — 正在刮削中
- `completed` — 全部完成
- `failed` — 任务失败（如并发超限）

### 模式说明

**mode: "detail"** (默认)
- 获取单个内容详情
- 如：单条推文、单个视频

**mode: "list"**
- 获取博主/频道内容列表
- 如：用户时间线、频道视频列表

### 参数说明

| 参数 | 类型 | 说明 | 适用平台 |
|------|------|------|----------|
| `mode` | string | `detail` 或 `list` | 全部 |
| `debug` | boolean | 调试模式，显示浏览器窗口 | 全部 |
| `browser` | string | 提取 cookies 的浏览器 | 全部 |
| `timeout` | number | 请求超时时间（毫秒），默认 60000 | 全部 |
| `scrollStrategy` | string | `min`/`max`/`all` - 滚动策略 | X/Twitter |
| `maxItems` | number | 列表模式最大收集数量 | X/Twitter, YouTube |
| `downloadAudio` | boolean | 下载音频文件 | YouTube, 抖音 |
| `extractTranscript` | boolean | 提取字幕（使用 Whisper） | YouTube |
| `whisperModel` | string | Whisper 模型：`tiny`/`base`/`small`/`medium`/`large` | YouTube |

### 平台特定用法

**X/Twitter - 获取用户时间线:**
```bash
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://x.com/claudeai"],
    "options": {
      "mode": "list",
      "maxItems": 30,
      "scrollStrategy": "max"
    }
  }'
```

**YouTube - 获取频道视频列表:**
```bash
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://www.youtube.com/@bestpartners/videos"],
    "options": {
      "mode": "list",
      "maxItems": 20
    }
  }'
```

**YouTube - 下载视频并提取字幕（使用本地 Whisper）:**
```bash
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://www.youtube.com/watch?v=xxx"],
    "options": {
      "mode": "detail",
      "downloadAudio": true,
      "extractTranscript": true,
      "whisperModel": "base"
    }
  }'
```

### 响应格式

`POST /api/scrape` 返回统一的 JSON 结构：

```json
{
  "success": true,
  "results": [
    {
      "url": "原始请求URL",
      "platform": "平台标识 (youtube | douyin | x)",
      "title": "内容标题",
      "author": "作者/发布者",
      "description": "内容描述",
      "publishedAt": "ISO 8601 发布时间",
      "content": "正文内容（推文/帖子正文）",
      "transcript": "字幕/转录文本",
      "transcriptLanguage": "字幕语言代码",
      "audioPath": "本地音频文件路径（如已下载）",
      "metadata": {},
      "scrapedAt": "ISO 8601 刮削时间"
    }
  ],
  "errors": [
    {
      "url": "失败的URL",
      "error": "错误描述"
    }
  ]
}
```

**字段说明：**

| 字段 | 类型 | 说明 | 必返 |
|------|------|------|------|
| `success` | boolean | 是否全部成功（任一失败即为 false） | 是 |
| `results` | ScrapeResult[] | 成功的刮削结果数组 | 是 |
| `errors` | {url, error}[] | 失败的 URL 及错误信息 | 否 |
| `url` | string | 原始请求的 URL | 是 |
| `platform` | string | 平台名称：`youtube`、`douyin`、`x` | 是 |
| `title` | string | 内容标题（视频标题、推文首行等） | 否 |
| `author` | string | 作者/频道/博主名称 | 否 |
| `description` | string | 内容描述（抖音视频文案、YouTube 描述等） | 否 |
| `publishedAt` | string | 发布时间（ISO 8601 格式） | 否 |
| `content` | string | 正文内容（list 模式下为摘要统计） | 否 |
| `transcript` | string | 音频转录字幕文本（需 `extractTranscript: true`） | 否 |
| `transcriptLanguage` | string | 字幕语言（如 `zh`、`en`） | 否 |
| `audioPath` | string | 本地音频文件绝对路径（需 `downloadAudio: true`） | 否 |
| `metadata` | object | 平台特定扩展数据（见下方各平台说明） | 否 |
| `scrapedAt` | string | 刮削完成时间（ISO 8601） | 是 |

**`metadata` 平台差异：**

| 平台 | mode | metadata 结构 |
|------|------|--------------|
| YouTube | detail | `{ mode: 'detail', duration: number, viewCount: number, likeCount: number, thumbnail: string }` |
| YouTube | list | `{ mode: 'list', totalVideos: number, videos: [{ title, url, duration, viewCount, publishedAt }] }` |
| DouYin | detail | `{ mode: 'detail', duration: number, coverUrl: string }` |
| DouYin | list | `{ mode: 'list', totalVideos: number, videos: [{ title, url, coverUrl }] }` — **无 `publishedAt`** |
| X | detail | `{ mode: 'detail', totalTweets: number, scrollStrategy: string, likes: number, reposts: number, replies: number, thread: TweetData[] }` |
| X | list | `{ mode: 'list', totalTweets: number, tweets: [{ author, content, publishedAt, likes, reposts }] }` |

### 热重载插件
```bash
POST /api/plugins/:name/reload
```

## 配置

编辑 `config.json`：

```json
{
  "port": 3000,
  "pluginsDir": "./plugins",
  "hotReload": true,
  "auth": {
    "token": "your-secret-token",
    "headerName": "x-api-token"
  },
  "cookieCache": {
    "cacheDir": "./cache/cookies",
    "ttlHours": 24,
    "autoRefresh": true
  }
}
```

## 开发新插件

复制 `examples/plugin-template/` 创建新插件：

```bash
cp -r examples/plugin-template plugins/my-platform
```

修改 `plugins/my-platform/package.json` 和 `index.ts` 实现 `IPlatformPlugin` 接口。

## Whisper 本地转录配置

YouTube 插件支持使用本地 Whisper 模型从音频提取字幕，无需依赖 YouTube 自带的字幕。

### 1. 安装 whisper.cpp

**macOS (Homebrew):**
```bash
brew install whisper-cpp
```

**从源码编译:**
```bash
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp && make
```

### 2. 下载模型文件

```bash
mkdir -p models

# 下载 base 模型（约 150MB，推荐）
curl -L -o models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# 或其他模型：
# tiny (约 75MB) - 最快，准确度一般
# small (约 500MB) - 更准，较慢
# medium (约 1.5GB) - 很准，很慢
# large (约 3GB) - 最准，非常慢
```

### 3. 确保 ffmpeg 已安装

```bash
brew install ffmpeg
```

### 字幕提取流程

1. yt-dlp 下载音频 (mp3)
2. ffmpeg 分割音频（如超过 5 分钟）
3. Whisper 本地转录每个片段
4. 合并结果返回

## 项目结构

```
├── src/
│   ├── core/              # 核心框架
│   ├── interfaces/        # 接口定义
│   └── utils/             # 工具函数
├── plugins/               # 插件目录
│   ├── youtube/
│   ├── douyin/
│   └── x/
├── models/                # Whisper 模型文件
│   └── ggml-base.bin
├── cache/                 # 缓存目录
│   ├── cookies/           # Cookies 缓存
│   └── temp/              # 临时音频文件
└── examples/
    └── plugin-template/   # 插件开发模板
```
