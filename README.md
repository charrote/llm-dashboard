# LM Studio 监控仪表盘

## 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 构建并启动
docker-compose up -d

# 访问 http://localhost:7890
```

### 方式二：Windows 一键启动
1. 双击运行 `启动仪表盘.bat`
2. 系统会自动启动代理服务并打开仪表盘

### 方式三：手动启动
```bash
# 1. 启动代理服务
cd proxy
npm install
npm start

# 2. 打开仪表盘
# 访问 http://localhost:7890
```

## 配置使用

### 1. 配置 LM Studio 地址
点击仪表盘右上角的 **设置** 按钮，可以：
- 修改 LM Studio 服务器地址
- 测试连接是否正常
- 查看可用模型列表

### 2. 配置 API 客户端
将你的 AI 应用的 API Base URL 从:
```
http://localhost:1234/v1
```
改为:
```
http://localhost:7890/v1
```

### 支持的应用
- Chatbox
- NextChat
- LibreChat
- Open WebUI
- 其他 OpenAI API 兼容应用

### 2. 仪表盘功能

#### 实时统计卡片
- **总请求数**: 累计请求数量
- **错误请求**: 失败请求数量
- **Prompt Tokens**: 输入 token 数量
- **Completion Tokens**: 输出 token 数量
- **平均延迟**: 响应时间统计
- **活跃模型**: 正在使用的模型数量

#### 24小时请求分布图
显示每小时请求数量，直观了解使用高峰期。

#### Token使用统计
环形图显示 prompt 和 completion token 比例。

#### API Key 统计表
按 API Key 分组显示：
- 请求数量
- Token 消耗
- 错误次数

#### 模型使用排行
显示各模型使用情况，包括：
- 请求数
- Token 消耗
- 错误次数

#### 实时请求日志
滚动显示最近 100 条请求详情：
- 时间戳
- HTTP 状态码
- 请求方法
- 使用的模型
- Token 数量
- 响应延迟
- API Key

## 文件说明

```
lmstudio-dashboard/
├── Dockerfile              # Docker 镜像配置
├── docker-compose.yml      # Docker Compose 配置
├── dashboard.html          # 前端仪表盘
├── 启动仪表盘.bat           # Windows 一键启动脚本
├── proxy/
│   ├── package.json        # 代理服务依赖
│   └── server.js           # 代理服务器源码
└── README.md               # 说明文档
```

## Docker 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LMSTUDIO_URL` | `http://localhost:1234` | LM Studio 服务地址 |
| `PORT` | `7890` | 监听端口 |

### 示例
```yaml
services:
  dashboard:
    ports:
      - "8080:7890"  # 映射到其他端口
    environment:
      - LMSTUDIO_URL=http://192.168.1.100:1234
```

## 工作原理

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   AI 客户端   │ ──── │   代理服务    │ ──── │  LM Studio   │
│  (Chatbox等)  │      │  :7890       │      │   :1234      │
└──────────────┘      └──────────────┘      └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │   仪表盘      │
                     │ dashboard.html│
                     └──────────────┘
```

1. AI 客户端请求发送到代理服务 (localhost:7890)
2. 代理服务记录请求数据并转发给 LM Studio (localhost:1234)
3. 前端仪表盘每 2 秒轮询获取统计数据并展示

## 注意事项

1. 确保 LM Studio 已启动并监听 1234 端口
2. Docker 部署时使用 `host.docker.internal` 连接宿主机 LM Studio
3. 数据存储在内存中，重启服务会清空数据
4. 仪表盘使用 Tailwind CDN，需要网络连接

## 故障排除

### Docker 部署问题
- 确保 Docker Desktop 已启动
- 运行 `docker-compose logs -f` 查看日志
- Windows: 使用 `host.docker.internal` 访问宿主机服务

### 代理服务启动失败
- 检查端口 7890 是否被占用
- 运行 `netstat -ano | findstr 7890` 查看占用进程

### 仪表盘显示"等待请求"
- 确认代理服务已启动
- 检查 API 客户端的 Base URL 是否配置正确
- 尝试发送一个请求测试

### 数据不更新
- 刷新浏览器页面
- 检查浏览器控制台是否有错误
