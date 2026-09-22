# OCR Client

[open-code-review](https://github.com/alibaba/open-code-review)（`ocr`）命令行工具的桌面可视化外壳。

它**不内置也不捆绑 `ocr`**——CLI 仍然由你自己 `npm install -g` 安装和升级，这个客户端只做两件事：

1. **让操作更方便**：在图形界面里选仓库、选审查范围（工作区 / 分支区间 / 单提交 / 全量扫描）、填参数、点“预览”确认待审文件、点“启动”跑审查，并实时看进度。
2. **让结果更可读**：把会话里的 finding 按文件分组、按严重度和类别筛选，配上行内 diff 和可选的上下文代码，而不是在终端里翻 JSON。

## 前置要求

| 依赖 | 说明 |
| --- | --- |
| **ocr** | 需自行安装：`npm install -g @alibaba-group/open-code-review`。客户端会定位它的原生二进制并直接调用。 |
| **git** | 任意可用的 Git for Windows 安装。 |
| **Node.js** | 仅开发/构建时需要（本项目在 Node 22 上验证）。 |

## 快速开始

```bash
npm install          # 安装依赖（会下载 Electron 二进制）
npm run dev          # 开发模式，带热更新
npm run build        # 构建到 out/
npm start            # 预览构建产物
npm run typecheck    # tsc + vue-tsc 双份类型检查
npm run smoke        # 端到端自检（见下文）
```

## 功能

**左侧栏**：仓库列表 → 展开看历史会话。点仓库名进入“新建审查”，点 ▶ 展开会话；点会话只**查看结果**，不是对话形式。

- 自动发现：在终端里跑过 `ocr review` 的仓库会自动出现（读取 `~/.opencodereview/sessions`）。
- 也支持手动「添加仓库」，或从侧栏移除（只隐藏列表，不删会话数据）。

**新建审查**：

- 四种模式：工作区 / 分支区间 / 单提交 / 全量扫描。
- 「预览」免费（不调用模型），先用表格列出待审文件、增删行数，以及被排除的文件和排除原因。
- 高级选项：`--effort`、`--concurrency`、`--timeout`、`--max-tokens-budget`、`--exclude`、本次覆盖 provider/model、`--no-filter` 等。
- 启动前显示将执行的命令行，运行中实时显示进度日志，可随时取消。

**结果页**：

- 概要条：finding 数、耗时、模型、文件覆盖率、终态、ocr 版本。
- 按严重度（严重/高/中/低/未分级）和类别筛选，支持全字段搜索；两项筛选的可见项由**该会话实际包含的数据**生成，所以老会话里没有 `severity`/`category` 字段的 finding 会归入「未分级」而不是被静默隐藏。
- finding 按文件分组（ocr 的分批审查会让同一文件出现多条），单列卡片 + 行内 diff（`现有代码` / `建议改为`）。
- 每条可复制建议代码 / 复制整条 / 查看上下文（按需读取**工作区当前内容**，并明确标注审查后可能已改动）/ 在编辑器中打开 / 在资源管理器中定位 / 标记忽略。
- 文件未完成的会话会显著提示，避免把「部分完成」误读成「没有发现问题」。
- **导出 Markdown**：把会话写成一份可读报告（会话信息、按文件分组的 finding、现有代码与建议代码，均带行号与原枚举值），用来交给 Codex 之类的 agent 或贴进 issue。筛选生效时按钮会显示「当前筛选 N/M」并额外出现「导出全部」——因为开着筛选时「导出」本身有歧义；旁边的「复制 MD」把同一份文档放进剪贴板，省掉一次落盘。

**设置页**：环境诊断（ocr 与 git 的实际路径、版本、被忽略的 git 候选）、git 路径覆盖、渠道与模型管理（读取/切换 provider、设置 API key、增删自定义渠道、`ocr llm test` 连通性测试）、配置备份与恢复。

## 两个环境坑

### 1. PATH 里的 MSYS2 git 会让 ocr 失败

如果机器上装了 devkitPro / MSYS2 之类的 POSIX 工具链，PATH 里**第一个** `git.exe` 可能是 MSYS2 版本，它把 `rev-parse --show-toplevel` 解析成 POSIX 路径：

```
MSYS2 git    → /home/admin/Documents/repo     → ocr 报 GetFileAttributesEx C:\home\admin 失败
Git for Windows → C:/Users/admin/Documents/repo → 正常
```

这不只影响本客户端——从资源管理器或任何桌面图标启动的程序都会中招，而在 Git Bash 里没问题是运气好。所以本客户端**不信任继承来的 PATH**：它会枚举候选 git，在临时仓库里逐个探测，只接受返回盘符绝对路径的那个。自动探测选错时，可在「设置 → git 路径覆盖」里手动指定。

### 2. `ELECTRON_RUN_AS_NODE` 会让 Electron 退化成 Node

某些以 Electron 为基础的应用（包括本客户端所在的开发环境）会设置 `ELECTRON_RUN_AS_NODE=1`。如果从这个终端启动本应用，Electron 二进制会以普通 Node 运行，`require('electron')` 拿到的是 npm shim 而不是 API，启动即报 `Cannot read properties of undefined (reading 'whenReady')`。

解决：启动前清除该变量。

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
npm run dev
```

## 文件位置

| 内容 | 位置 |
| --- | --- |
| ocr 的配置 | `~/.opencodereview/config.json` |
| ocr 的会话记录 | `~/.opencodereview/sessions/<flattened-key>/*.jsonl` |
| 本客户端的设置 | `%APPDATA%\ocr-client\settings.json`（只存 git/ocr 路径覆盖与被隐藏的仓库；不存 API key） |
| 配置备份 | `%APPDATA%\ocr-client\config-backups\`（每次通过界面写 config.json 前自动备份，最多 50 份） |

会话目录名是仓库路径压平后的结果（`:` 和分隔符变成 `-`），这个变换**不可逆**（`-` 同时表示分隔符和字面连字符）。因此客户端不靠它猜路径，而是读取会话文件第一条记录里权威的 `cwd` 字段。

## 架构

```
src/
  shared/      types.ts（全部 IPC 数据契约）、api.ts（window.ocr 接口）
  main/        proc / git / ocr / env / config / settings / sessions / source / repos / runner / exporter / ipc / index
  preload/     contextBridge 暴露的类型化 window.ocr
  renderer/    Vue 3 + Pinia，手写 CSS（无 UI 框架、无 router）
```

几点设计取舍：

- **安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。渲染进程不碰 fs 和 child_process，只调用 preload 暴露的类型化接口。API key 永不回传渲染进程，只显示 `前4位…后4位`。
- **导出的 Markdown 由渲染进程生成、主进程落盘**：只有渲染进程知道用户此刻的筛选状态和哪些 finding 被标记忽略，也只有主进程能弹原生保存框、写文件。两边各做一半：内容由渲染进程产出，主进程只负责「弹框 + 写」，且目录永远来自对话框、文件名先被剥掉路径与 Windows 非法字符——渲染进程给不出一个可写路径。
- **错误不抛异常**：所有 IPC 返回 `{ok:true,data} | {ok:false,error}`，由界面决定怎么呈现。
- **直接调用原生二进制**：`ocr` 的 npm 包是个 JS launcher，会包装 Go 二进制并做 detached 的更新检查。客户端沿 npm shim 找到 `opencodereview.exe` 直接调用，避开 `.cmd` 的引号问题和不必要的后台进程。
- **写配置前必先备份**：`ocr config unset` 只支持删除 provider / `custom_providers.<name>` / `mcp_servers.<name>`，**不是通用删键**，所以键名写错就无法撤销——备份是必需的保险。
- **不用 vue-router**：单窗口外壳，左栏常驻、只有右栏切换，hash 路由只会增加复杂度。
- **不用 UI 组件库**：原生表单控件 + 手写 CSS，产物更小、样式完全可控。

## 端到端自检

`scripts/smoke.cjs` 加载**构建产物**并驱动真实窗口，逐个走一遍用户点击路径，抓取 DOM 断言和截图到 `smoke-out/`：

```bash
npm run build
npm run smoke
```

它会检查：仓库发现 → 点仓库进配置 → 预览待审文件 → 展开会话 → 打开会话 → 按文件分组渲染 finding → 切换筛选 → 导出 Markdown → 设置页诊断。并且**断言点击的仓库就是面板配置的仓库**（`report.violations` 非空时进程退出码为 1），以及整轮运行零 console 错误。

导出阶段只有原生保存框是假的：`scripts/smoke.cjs` 在同一个主进程里替换 `dialog.showSaveDialog`，其余全部走真实路径——渲染进程拼出的 Markdown、IPC、文件名清洗、真正写盘。断言包括：文档标题就是页面上的仓库、findings 数量与界面显示的一致、「导出全部」忽略筛选后条数等于总数、代码围栏成对、`../../evil.md` 这类名字被压成 `evil.md` 且默认目录仍在「文档」下、取消保存既不报错也不落盘。产物在 `smoke-out/export/`。

可选的追加阶段（会真实调用模型）：

```powershell
$env:SMOKE_REPO = "C:\path\to\git\repo-with-uncommitted-changes"
npm run smoke              # 跑一次真实审查，断言自动跳到结果页
$env:SMOKE_CANCEL = "1"
npm run smoke              # 启动后取消，断言状态与无残留进程
```

## 验证情况

在本机（Windows，Git for Windows 2.47.1，ocr 1.12.8，provider 为本地网关上的 `deepseek-flash`）实际验证过的：

- 发现 5 个真实仓库并正确解析各自路径；展开、读会话摘要与 finding。
- 预览：某仓库 4 个改动文件 → 待审 3 / 排除 1（`tests/` 被默认排除），`+197/−47`。
- 渲染一个含 9 条 finding、跨 3 个文件的真实历史会话；严重度与类别筛选联动正确（关掉「中」后 9 → 5）。
- 分支选择器读到 101 个本地分支（当前分支置顶 + 按提交时间倒序），提交选择器读到 60 个真实提交。
- **真实审查全流程**：在一个临时仓库上点「启动审查」，10 秒完成，1/1 文件、2 条 finding，自动跳转到结果页，模型正确报出植入的两个缺陷。
- **取消**：启动后取消，状态显示「已取消」、toast 提示、按钮恢复，且 `taskkill /T` 无残留 `opencodereview` 进程。
- 设置页读写：`ocr config set` 的写入语义（含 `models "a,b"` 逗号串会转成 JSON 数组）经实测确认，测试用临时渠道验证后 config.json **逐字节复原**。
- **导出 Markdown**：对一个含 4 条 finding、跨 2 个文件的真实会话导出成功（`smoke-out/export/`）：标题与页面仓库一致，筛选到 1 条时导出 1 条、「导出全部」导出 4 条，代码围栏成对，取消保存不报错也不落盘。另外用构造数据覆盖了 report 生成函数的分支：反引号比围栏长的代码块（原文含 ``` 时自动加长围栏）、缺 `severity`/`category`/行号的 finding、路径里的 `|` 不破坏概览表格、以及 0 条 finding 的空会话。
- 全流程零 console 错误。

**尚未验证**（如实说明）：

- 「全量扫描」和「单提交」模式只验证了界面与参数拼装，没有真跑完整审查。
- 渠道切换（`ocr config set provider ...`）只验证了写入被 CLI 接受，没有实测切换后审查用的是新渠道。
- 「无可审查内容时退出码为 0」这条分支是推理修复的（见 `stores/run.ts` 的 `onRunDone`），没有构造出该场景实测。
- 导出的 Markdown 没有在 GitHub/VS Code 预览里逐一核对渲染结果，只断言了结构（标题、条数、围栏配对）。
- 曾观察到**两次**未复现的异常：点 `city-builder` 的面板显示成了 `shanhai_client`（`repo-row.active` 也落在 `shanhai_client` 上，说明 `activeRepoDir` 在点击前就已被改成了它）。同一轮里 `scripts/probe*.cjs` 探针连续 20 次采样都复现不出来，`listRepos()` 以 `dir` 为键去重、代码里找不到能产生该现象的路径——目前最像的解释是 smoke 窗口是真实可见窗口，被桌面上的一次误点击命中了那一行。已把「点击的仓库 == 面板配置的仓库」固化成 smoke 断言，若复发会被直接抓住。

## 后续可做

- 语法高亮（diff 逐行着色需要处理跨行结构，收益与风险需要权衡）。
- 会话对比（`ocr session compare`）与导出 HTML（Markdown 已经有了，见「结果页」）。
- 导出时可选带上工作区当前代码片段（现在只导出 finding 自带的 `existing_code` / `suggestion_code`）。
- 记住上次打开的仓库（`AppSettings` 里预留过字段，因未使用已移除——需要真正的恢复逻辑时再加）。
