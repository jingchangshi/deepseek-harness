# Agent Note: Preset discovery dereferences symlinked directories

Status: implemented

[English](2026-09-07-preset-discovery-dereferences-symlinks.md) | 中文

## 问题

把一个 preset 从 `<dshHome>/.agent-presets` 移到纳入版本控制的检出目录、再用 `ln -s` 链接回来后，它就从 roster 里消失了。`scanRoot` 依据每个子项的 dirent 类型做分类，而 dirent 类型携带 lstat 语义，因此链接报告的是 `isSymbolicLink`，通不过 `isDirectory()` 测试，被静默跳过。它的名字仍在磁盘上占着那个 id——`copy` 会拒绝——但没有任何界面显示可选择或可删除的东西；只有把真实目录移回来，preset 才重新出现。

## 决策

`scanRoot` 对通过 `PRESET_ID` 的条目分两步分类：目录 dirent 与从前一样是一行；符号链接用 `stat` 解引用一次，且仅当目标是目录时成为一行，其 `path` 仍经由根目录拼接。指向文件的链接与悬空的链接，同它们实质上等同的同名普通文件一样被跳过。trust 依旧来自发现该行的根目录。

下游一切都经由 roster 行的路径读取。健康检查透过链接解析 `agent.cordis.yml`，因此不含组装文件的链接目录与不含组装文件的根下目录一样会成为 broken 行；`preset.yml` 元数据、挂载与组装文件 stamp 也都透过链接读取。`copy` 的占用检查 stat 目标，并拒绝被链接占用的 id。`remove` 用 `lstat` 区分链接或 Windows junction 与真实目录，再解除链接而不对它执行递归删除；删除 roster 行不可能触及它指向的检出目录。

## 曾考虑的替代方案

对每个条目取 realpath，如同 LSP 工作区接缝把别名归一到同一身份：roster 按「已配置根目录之下的 id」寻址，而不是按文件系统身份，重写每行的路径会把 `remove` 的包含性检查（`preset.path` 必须位于可写根目录之下）从部署所配置的那个根目录上挪开。用 `stat` 逐个 stat 子项、不再读 dirent 类型：在一次 `list()` 每次调用都不加缓存地重跑的扫描里，为每个非目录子项多付一次系统调用，只为获知 dirent 在最常见的真实目录情形下已经给出的答案。把悬空链接报告为损坏行，即幽灵目录的待遇：那份契约覆盖的是目录，而一个名字形如 preset id 的普通文件本来就被跳过——悬空链接是同样的非 preset 残留，不是值得上报的损坏；若出现真实案例再重新考虑。

## 后果

- preset 可以放在磁盘任何位置、在真实检出里开发；roster 行、两个选择器、挂载与复制/删除都经由链接寻址。
- 删除一个以链接呈现的 preset 只移除链接、保留目标文件——这一点由测试钉住，因为目标通常是用户自己的版本控制树。
- 每个符号链接条目在每次扫描时多付一次 `stat`，这条路径本就接受不加缓存；既非目录也非符号链接的条目不增加开销。
- 由真实临时目录树上的单元测试钉住（链接 preset 以经由根目录的路径被发现、健康检查透过链接读取、非目录链接被跳过、删除只移除链接），并由 web 创作通道钉住——它把一个来自真实检出的 preset 链接进自己的 user 根目录，并断言组装后的设置区把它渲染成与根下目录无异的自定义行。
