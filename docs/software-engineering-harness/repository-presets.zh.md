# 仓库 Preset

[English](repository-presets.md) | 中文

本文定义[工程架构](architecture.zh.md)中的仓库初始化、preset 身份和安装所有权。

## 摘要

Preset 是版本化的仓库脚手架，不是 runtime 配置或永久安装器所有权。通用初始化不包含特定 compiler 命令。必须显式选择 preset；更换仓库或增加 backend 不需要通用 runtime 分支。

## 目录

- [Preset 文件](#preset-files)
- [初始化](#initialization)
- [所有权与身份](#ownership-and-identity)
- [Ascend preset](#ascend-preset)
- [仓库知识](#repository-knowledge)

<a id="preset-files"></a>
## Preset 文件

`tools/agent/presets/<id>/preset.yaml` 声明 `schemaVersion: 1`、使用 Profile 小写语法的 `id`、非空 `version` 和非空 `files` 列表。选择器必须匹配声明的 ID。路径相对 Preset 目录，位于 `.agent/config/`、`.agent/adapters/`、`.agent/profiles/` 或 `.agent/scripts/` 下。拒绝绝对路径、路径穿越、大小写等价的重复路径、符号链接、Artifact Schema、任意大小写的部署路由和角色 Persona。初始化写入文件前，所有列出的文件必须存在。

Preset digest 对包含 ID、版本和按路径排序的相对路径及文件内容 SHA-256 配对的 JSON 求 SHA-256。`.agent/preset.json` 记录初始脚手架身份。仓库编辑不会改变该历史脚手架身份；任务策略身份必须另行哈希有效仓库配置。

<a id="initialization"></a>
## 初始化

`node tools/agent/agentctl.mjs init --root <repository>` 安装缺失的通用模板。增加 `--preset <id>` 选择 `tools/agent/presets/<id>/`。安装器在指定 `--root` 时接受相同选择器。筛选缺失文件前，preset 文件覆盖通用模板，因此新仓库直接获得所选项目声明。

通用命令故意保持未配置：仓库提供命令前，必需验证报告 `NOT_RUN`。初始化不猜测 compiler、backend、容器、用户、构建目录或硬件目标。写入 schema、标记或策略前，已有目标目录和文件必须解析到所选仓库内。不同 preset 不能隐式替换已有记录的 preset；必须显式协调仓库配置和初始身份。

<a id="ownership-and-identity"></a>
## 所有权与身份

Artifact schema 由 runtime 管理，保留严格安装哈希检查。项目配置、profile、adapter 和 preset 元数据由仓库拥有：初始化和重装保留现有字节，包括此前安装器记录哈希后的修改。安装记录中的旧策略条目不授予覆盖权限。

Core freeze 哈希 runtime 代码和 artifact schema，不哈希仓库策略或 preset 文件。Preset ID、版本和 digest 独立标识脚手架内容。用户 provider route 和角色指令仍归 deployment 所有，绝不复制到仓库 preset。

<a id="ascend-preset"></a>
## Ascend preset

`ascendnpu-ir` Preset 包含项目声明、Compiler Profile、验证策略、命名容器运行器和仓库拥有的检查。其容器、用户、构建环境、`bishengir` 命令、A5/A3 目标和 PureAIV/MixCV 状态均为仓库数据。执行前协调部署值；未执行的硬件保持 `NOT_RUN`。[Ascend 集成](ascend-integration.zh.md)拥有构建和 IR 验证细节。

<a id="repository-knowledge"></a>
## 仓库知识

项目配置可声明相对路径的 `knowledge` YAML 文件，其中包含 `schemaVersion: 1`、`instructionFiles` 和 `skillRoots`。所有指令文件和 skill root 必须存在且解析到仓库内。每个 skill root 发现直接子目录中的 `SKILL.md`；每个发现的文件必须带 YAML frontmatter，包含非空 `name` 和 `description`。拒绝重复 skill 名称。没有 `SKILL.md` 的辅助目录不属于 skill。

每个隔离角色通过 `context.repositoryKnowledge` 获得仓库相对指令路径和按路径排序的 skill 目录，其中包含名称、描述和 `SKILL.md` 路径。不会自动获得指令正文或 skill 正文。角色使用普通读取工具加载与任务相关的文件。实际 DSH child 请求把此上下文与其他角色输入一起记录；领域知识不改变固定角色身份或 deployment persona。

## 开发备注

无。
