# 博物馆展台监测

基于 oneNET 物模型的博物馆展台环境监测与远程控制上位机，实时展示温湿度、光照、防盗报警数据，支持远程布防/撤防和蜂鸣器控制。

## 功能

- **实时仪表盘** — 温度、湿度、光照、报警状态四合一卡片
- **历史趋势图** — 温湿度双轴曲线 + 光照强度曲线（Chart.js）
- **远程控制** — 一键布防/撤防、蜂鸣器开关
- **报警记录** — 温度过高、湿度过高、光线过暗事件日志
- **账号系统** — 注册/登录，数据隔离
- **演示模式** — 无需配置即可预览完整界面

## 架构

```
┌──────────────┐    读取数据    ┌──────────────┐    定时轮询    ┌─────────────┐
│  index.html  │ ◄─────────── │   Supabase   │ ◄──────────── │  Edge        │
│  (前端页面)   │  Realtime   │   (云端)     │   每30秒      │  Function    │
│              │ ───────────► │              │ ─────────────►│  (云端Deno)  │
│  控制按钮     │  调用Edge    │  数据库+存储  │               │              │
└──────────────┘              └──────────────┘               └──────┬───────┘
                                                                    │
                                                               oneNET API
                                                                    │
                                                               ┌────┴───────┐
                                                               │  展台设备   │
                                                               └────────────┘
```

| 组件 | 技术 | 部署位置 |
|---|---|---|
| 前端 | 单 HTML + Chart.js + Tailwind CSS | GitHub Pages |
| 后端数据库 | Supabase (PostgreSQL + Realtime) | Supabase 云 |
| 桥接服务 | Supabase Edge Function (Deno) | Supabase 云 |
| 设备通信 | oneNET HTTP API | oneNET 平台 |

## 快速开始

### 前端

直接访问 `https://liang-xl-stm.github.io/booth-monitor/` 或本地打开 `index.html`。

默认账号：`admin` / `admin123`

### 数据库

在 Supabase SQL Editor 依次执行：

1. `schema.sql` — 建表 + RLS + Realtime
2. `seed.sql` — 测试数据

### 桥接服务

```bash
supabase link --project-ref <your-project-ref>
supabase secrets set ONENET_ACCESS_KEY="xxx" ONENET_PRODUCT_ID="Hc8y9729b1"
supabase functions deploy booth-bridge
```

然后在 SQL Editor 执行 `supabase/cron-setup.sql` 设置定时触发。

## 项目结构

```
├── index.html          # 前端页面
├── supabase.min.js      # Supabase SDK (本地副本)
├── schema.sql           # 数据库建表 DDL
├── seed.sql             # 测试数据
├── supabase/
│   ├── config.toml      # Edge Function 配置
│   ├── cron-setup.sql   # pg_cron 定时任务
│   └── functions/
│       └── booth-bridge/
│           └── index.ts # 桥接 Edge Function (Deno)
├── bridge/              # 本地桥接服务 (可选，Node.js)
│   ├── config.js
│   ├── index.js
│   └── package.json
└── model-Hc8y9729b1.json # oneNET 物模型定义
```

## 物模型

| 属性 | 类型 | 读写 | 说明 |
|---|---|---|---|
| temperature | double | 只读 | 当前温度 (-40~85 ℃) |
| humidity | double | 只读 | 当前湿度 (0~100 %) |
| ambient_light | double | 只读 | 环境光照 (0~65535 lx) |
| alarm_status | bool | 只读 | 报警状态 |
| sensor_armed | bool | 读写 | 传感器布防/撤防 |
| beep_enabled | bool | 读写 | 蜂鸣器开关 |
