# 安全与数据策略

[English](security-data-policy.md) | 中文

每个任务声明 `public`、`internal` 或 `sensitive`。每条路由声明其最大类别以及是否使用外部中继。`assertDispatchAllowed` 在模型调度前检查两者。

## 敏感输入

敏感输入必须是合成、匿名化或明确批准的数据。即使完成处理，外部中继路由也拒绝敏感输入。明确批准在仓库证据中记录来源、路由、批准人和到期时间。所有 Magpie 路由均为外部中继，拒绝敏感输入，包括经过处理的敏感输入。

## 密钥

提交的模型配置只包含凭据环境变量名称，不包含值。DSH 在请求时解析凭据。项目 adapter 使用 argv 数组，不插值 shell 命令。仓库检查应在验收前扫描任务 artifact 和 adapter 文件中的私钥、bearer token 和 API key。

## 范围

该策略防止项目编排中的意外路由。它不是操作系统隔离或合规平台。部署负责人仍需负责 provider 协议、保留设置、访问控制和批准人身份。

## Dev Note

无。
