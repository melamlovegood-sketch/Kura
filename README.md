# Kura · 蔵

> 把冲动消费变成一次可回顾、可解释的决定。

[![Live Demo](https://img.shields.io/badge/demo-kura--tan.vercel.app-7C6F64)](https://kura-tan.vercel.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Kura 是一个面向个人的消费决策与财务复盘 PWA。它不只记录“花了多少钱”，还把冷静期、待购清单、预算、储蓄目标和购买后复盘连接成一条完整流程。

**线上体验：** [kura-tan.vercel.app](https://kura-tan.vercel.app)

## 核心流程

```text
产生购买念头
    ↓
冲动过滤与冷静期
    ↓
待购清单 / 许愿池
    ↓
预算与购买决策
    ↓
7 天、30 天消费复盘
```

## 已实现能力

- AI 对话解析记账、预算和购买意图，支持文字与截图输入
- 72 小时冷静期以及到期后的保留/放弃决策
- 待购清单、愿望储蓄进度和消费预算
- 购买执行计时、品牌库与个人 SOP
- 购买后的 7 天和 30 天复盘
- 邮箱账户、Supabase 云同步与多用户数据隔离
- 可安装 PWA、离线缓存与 Web Push 基础设施

项目仍在迭代中。价格追踪以及部分预算建议、排序和自定义功能尚未完成，详细进度见 [`STATUS.md`](STATUS.md)。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite、Tailwind CSS |
| 状态与图表 | Zustand、Recharts |
| 数据与认证 | Supabase Auth、PostgreSQL、Row Level Security |
| AI 接入 | 可配置的 Qwen / OpenAI / Claude / Gemini 适配层 |
| 应用形态 | PWA、Web Push、响应式移动端界面 |

## 本地运行

```bash
git clone https://github.com/melamlovegood-sketch/Kura.git
cd Kura
npm install
cp .env.example .env.local
npm run dev
```

在 `.env.local` 中配置自己的 Supabase 项目：

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_VAPID_PUBLIC_KEY=your-vapid-public-key
```

客户端只能使用 Supabase anon key。服务端密钥和 VAPID 私钥应保存在相应平台的 Secrets 中，不能以 `VITE_` 变量暴露或提交到 Git。

## 数据库与隐私

请按编号执行 `supabase/migrations/` 中的完整迁移链。早期版本曾采用单用户、关闭 RLS 的原型结构；`0009_add_user_id.sql` 会迁移为多用户模型，为各表添加 `user_id`，重新启用 RLS，并用 `auth.uid() = user_id` 限制数据访问。

用于现有数据库时，请先备份并阅读迁移说明：`0009` 会清理无法归属到用户的早期开发数据。完成后应运行文件末尾的验证查询，确认公开表的 `relrowsecurity` 均为 `true`。

## 项目文档

- [`SPEC.md`](SPEC.md)：产品目标与功能规格
- [`STATUS.md`](STATUS.md)：模块完成度和已知缺口
- [`supabase/migrations/`](supabase/migrations)：可审阅的数据库变更历史

## License

Released under the [MIT License](LICENSE).
