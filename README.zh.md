# dsh-nx

[English](README.md) | 中文

让 DeepSeek Harness 的 agent 驱动 Siemens NX——**包括 NX 12**，而现有的那个 NX 桥根本跑不了 NX 12。

NXOpen 跑在 NX 进程内，所以自动化的唯一办法是起一个批处理 NX、把 journal 放进去跑。这个仓库就是
这件事在 NX 12 上的实现：把桥移植到 NX 12 真正内嵌的那个解释器；一个能告诉你「这次到底成没成」的
执行器；以及一个能把三个版本分清楚的探测。这个领域里没有别人覆盖 NX 12，因为别人做不到。

## 缺的是什么，这里补了什么

| 能力 | 之前 | 现在 |
|---|---|---|
| 自动化 **NX 12** | 上游桥要求 Python 3.10+，而 NX 12 内嵌 3.6.1，所以根本跑不起来 | 五个模块、1,785 行移植过去；NX 12 上跑的是同一套 16 个工具 |
| 知道一次运行**成没成** | `run_journal.exe` 对一个自己吞掉异常的 journal 照样返回 `0` | `run-journal`：判定来自日志，超时杀进程树，JSON 里带原因 |
| 知道机器上是**哪个 NX** | 查注册表，或者靠猜 | `probe.py`：列出每一份安装、各自的解释器、以及 `verified` / `expected` 标签 |
| 把它**装上** | 克隆、建 venv、做 junction、设 `NX_HOME`、配许可目录，全手工 | `install.ps1` + `doctor`，后者会指出唯一出错的那一处 |
| 让 agent 会写 NXOpen | 一份把版本写死在文字里的技能 | 同一份技能，解释器指引和 API 检查都跟着版本走 |

前两行是这个仓库存在的理由，后三行是它能在真机器上跑起来、而不只是演示的原因。

## 安装

NX 本身既不安装也不修改。`install.ps1` 建一个给 sidecar 用的 venv、取回 pinned 技能、并做好 junction。

```powershell
git clone https://github.com/27painter/dsh-nx
cd dsh-nx
npm install -g .            # 把 dsh-nx 放进 PATH
dsh-nx install              # [1/5] python  [2/5] venv-nx  [3/5] 技能  [4/5] NX_HOME  [5/5] junction
dsh-nx doctor               # 只读；缺东西时退出码 1
```

`dsh-nx install` 是对 `install.ps1` 的薄包装；想直接看脚本输出就跑脚本：

```powershell
.\install.ps1
.\install.ps1 -BaseDir "E:\cad" -Force      # 换位置 / 重建
```

包还没发到 npm，所以 `npm install -g dsh-nx` 现在解析不到。

到这里**技能**就能用了。要用 **MCP 工具**，还得做下面的插件行。

### 插件行

开发机上实际做的是：往 profile 里做一条 junction、加一条依赖、加一条 bundle 记录。
`dsh plugin --profile desktop add link:<路径>` 是走 pnpm 的等价做法。

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-nx" -Target "D:\path\to\dsh-nx"
```

用 `link:` 到达的插件，裸导入是按它的**真实路径**解析的，所以 `@deepseek-ai/dsh-mcp-client` 必须从
那里够得着，否则加载时直接失败：

```powershell
$src = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-mcp-client"
$dst = "D:\path\to\dsh-nx\node_modules\@deepseek-ai\dsh-mcp-client"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
New-Item -ItemType Junction -Path $dst -Target $src
```

然后在 `dependencies` 里加 `"dsh-nx": "link:D:/path/to/dsh-nx"`，在 `dsh.profile.bundles` 里加 `"dsh-nx"`。

## 状态

下面所有内容都以这张表为前提。

| | 状态 |
|---|---|
| NX 12（12.0.0.27，CPython 3.6.1） | 16 个工具、技能、`run-journal` 都在真实零件上跑过 |
| NX 2406（2406.1700，CPython 3.10） | 同上，外加两个示例端到端跑通 |
| NX 2506（CPython 3.12） | **从没跑过。** 3.12 下能解析、能导入；探测把它标成 `expected` 而不是 `verified` |
| 16 个 MCP 工具 | 只覆盖建模与导出——**不含 Drafting**：没有视图投影、没有尺寸、没有标题栏、没有 GB 图框、没有 PDF |
| 驱动你已经打开的那个 NX 窗口 | **做不到**，这是 NXOpen 的进程模型决定的 |
| npm 上的包 | 还没发布 |

要从 NX 出图，无论走哪条路都落在 journal 上——工具做不了，这份 README 也不假装它能。

## 为什么需要它

两条硬约束决定了这里每个设计：

**NXOpen 跑在 NX 里面。** 没有 COM 服务器，没有进程外句柄，agent 没有任何办法挂到你打开的那个 NX
上。可选的路只有两条：「自己起一个批处理 NX」或「把 journal 拷进去手工跑」。这里每条路都走第一条，
这也是常驻桥活着时 NX 被占用的原因。

**NX 各版本不共用一个 Python。** 12 内嵌 3.6.1，2406 是 3.10，2506 是 3.12。上游瞄的是最新的那个，
把最老的那个——也就是存量最多的 NX 12——留在了没有任何自动化路径的状态。这里的移植按 3.6.1 写、
向后打垫片，所以新版本跑的是同一套代码，垫片自动失效。

## 箱子里有什么

| 路径 | 行数 | 是什么 |
|---|---|---|
| `nxsrc/` | 3,030（30 个文件） | 跑在 NX **内部**的桥——移植版，见[建立在什么之上](#建立在什么之上) |
| `nxsrc/nx_mcp/nx_bridge.py` + `bridge.py` | 766 + 872 | 移植后的核心：会话、回环 JSON-RPC、16 个工具实现 |
| `lib/run-journal.mjs` | 408 | 执行器：解析 NX、运行、判定、杀进程 |
| `lib/probe.py` | 243 | 找出机器上每一份 NX，并标出各自能干什么 |
| `bin/dsh-nx.mjs` | 374 | `install` / `doctor` / `where` / `serve` / `run-journal` / `bridge-start` / `bridge-stop` |
| `lib/capture.mjs` | 74 | 用文件描述符而不是管道跑子进程 |
| `lib/nx-root.mjs` + `lib/paths.mjs` | 77 + 71 | 「用哪个 NX」只有一处实现，以及布局默认值 |
| `install.ps1` | 155 | venv、pinned 技能、junction、`NX_HOME` |
| `examples/` | 3 个 journal | 冒烟、零件、以及这个零件的 GB A3 工程图 |

`bin/`、`lib/`、`install.ps1` 里的自有代码合计 1,402 行。

## 三条入口

| 路线 | 机制 | 什么时候用 |
|---|---|---|
| **技能**（默认） | agent 写 NXOpen Python，`run-journal` 执行 | 凡是需要 agent 现写的：建模、工程图、有限元、运动仿真 |
| **`run-journal`** | 一个 journal 进，一个判定出 | 手上已经有 journal，只想知道成没成 |
| **16 个 MCP 工具**（opt-in） | 对着常驻批处理 NX 的类型化调用 | 同一个零件上要调很多次小工具，冷启动那 60 秒不划算 |

技能默认开，因为它不占 NX。工具默认关，因为启动 dsh 不该等一个 CAD 应用。

```
  agent ──写──▶ journal.py ──run-journal──▶ run_journal.exe ──▶ 批处理 NX ──▶ .prt / .pdf / .stp
                    │                            │
                    │                            └── 判定来自日志，不是退出码
                    └── 先过 check_journal.py（3.6 子集，任何版本都能跑）

  agent ──nx_* 工具──▶ dsh-nx 插件 ──stdio──▶ sidecar（venv-nx）──回环──▶ 批处理 NX
```

## `run-journal`

```powershell
dsh-nx run-journal .\part.py                       # workdir 默认是 journal 所在目录
dsh-nx run-journal .\part.py -w .\build -t 900     # 指定 workdir 和超时（默认 600 秒）
dsh-nx run-journal .\part.py --expect DRAWING_OK   # 要求输出里出现某个 token
dsh-nx run-journal .\part.py --allow-traceback     # journal 会捕获并记录异常
dsh-nx run-journal .\part.py --log run1.log        # 换个日志文件
dsh-nx run-journal .\part.py --json                # 机器可读的判定
dsh-nx run-journal .\part.py --no-kill             # 超时不杀，保留现场
dsh-nx run-journal .\part.py --kill-grace 5        # 进程树有几秒可以死（默认 2）
dsh-nx run-journal .\part.py --print-command       # 只打印命令和环境，不跑
```

**为什么判定不是退出码。** `run_journal.exe` 对一个自己接住异常的 journal 返回 `0`，对干净结束返回
`0xC0000409`。这两个数字都不是调用方想要的，所以由日志来判：

| 信号 | 判定 |
|---|---|
| `General Fault Exception`、`failed to initialize UFUN`、`FATAL ERROR`、`_FAIL`、`BRIDGE_FAIL` | fail |
| 有 traceback **且** 非干净退出 | `uncaught exception (exit N)` —— `--allow-traceback` **不豁免** |
| 有 traceback **且** 干净退出 | 默认 fail；加 `--allow-traceback` 降为 warning |
| `--expect TOKEN` 没出现 | fail |
| 退出码既不是 `0` 也不是 `0xC0000409` | fail（除非上面已经判了） |

退出码是用来区分「崩了」和「健壮脚本」的：每步 try/except 记日志继续跑的 journal 照样干净结束，而
停在异常上的那个不会。

**超时时**对子进程树跑 `taskkill /T /F`——NX 会派生子进程，只杀 shell 会把 `ugraf.exe` 留在那里占着
许可——等 `--kill-grace` 秒后复查 pid。JSON 里有 `killed` 和 `kill_ok`。

**日志是追加的，且只判本次写入的字节**，所以上一次失败会留在盘上，但不会决定下一次的结论。

## 出问题的时候

这些都是在这台机器上真遇到过的，按症状查：

| 症状 | 真正的原因 | 怎么办 |
|---|---|---|
| `NX_HOME` 明明对，`doctor` 却说 `nx not found` | 沙箱读不到安装目录，解释器探测根本没跑起来 | 看它下面那行，那里写了原因；把下面的路径加进白名单 |
| 运行停在 `failed to initialize UFUN 948792` | NX 够不到许可或配置目录 | 白名单 `C:\ProgramData\Siemens` 和 `%LOCALAPPDATA%\Siemens\NX<release>`，或设 `UGII_USER_PROFILE_DIR` |
| 判定因为 traceback 失败，但 journal 其实跑完了 | 分步 try/except 的 journal 本来就会记 traceback | 加 `--allow-traceback`，或用 `--expect` 把关 |
| `tools/list` 什么都没有 | 桥是在 MCP 握手期间才起的，而握手先超时了 | 先 `dsh-nx bridge-start`，**再**启动 dsh |
| 插件加载报 `ERR_MODULE_NOT_FOUND` | `link:` 插件看不到 `@deepseek-ai/dsh-mcp-client` | 按[插件行](#插件行)补那条 junction |
| `doctor` 点名了磁盘上另一份副本 | 工作区和已安装副本是两处 | 更新它点名的那份 |
| 日志只有 100 字节，但 journal 干了不少活 | NX 在非控制台环境下缓冲 stdout | 用 `--expect` 判定，或看 journal 自己写的文件日志 |
| 超时之后 `ugraf.exe` 还在 | 早先的版本只杀 shell | 当前版本杀整棵树；`--no-kill` 是显式选择，不是默认 |

## 建立在什么之上

两个上游。哪些是「用」，哪些是「重写」，这里划清楚。

**桥 —— [`DreamEnding/NX_MCP`](https://github.com/DreamEnding/NX_MCP) 的 `4a7c8811`，MIT。**
上游要求 Python 3.10+，提供 C# GUI 桥和 Python 批处理桥两个。这里只留 Python 那个，因为 C# 桥要按
NX 12 的程序集重编，而加载未签名 DLL 需要 NX Open .NET 作者许可。五个模块——`bridge_journal.py`、
`nx_bridge.py`、`bridge.py`、`runtime.py`、`workspace.py`，共 1,785 行——被移植到 3.6.1：

- 去掉 `from __future__ import annotations`，再用**按 AST 偏移的改写工具把 256 条注解逐条加引号**，
  让它们永不被求值（`str | None`、`dict[str, int]` 是 3.10/3.9 语法）。正则会把注释和排版一起吃掉，
  这个不会。
- 给 3.6 补了一个 `dataclasses` 替身，且**在 3.7+ 上是直通**——Pydantic 会检查 `__dataclass_fields__`，
  只模仿 dataclass 的东西会被它拒掉。
- `str.isascii()`、`Path.unlink(missing_ok=True)` 和 walrus 运算符逐处替换。这三处都是**跑工具跑出来
  的**，读代码一处也看不出来。
- 拉伸那一段重写：上游的 `CreateRuleCurveFeature([sketch], Null)` 在 12 和 2406 上都报 NX 错误
  650004，现在按顺序试四种建截面的组合并记录是哪一步失败。失败会指出具体那一步，而不是丢回一句
  "Bridge execution failed"。

每一处改动的证据都记在 [`nxsrc/PORT-NOTES.md`](nxsrc/PORT-NOTES.md)。

**技能 —— [`EVOL233awa/nxopen-journal`](https://github.com/EVOL233awa/nxopen-journal) 的
`4b77d88`（v1.3.0），MIT。** 作者是另一个人，不是这个账号。安装时以 zip 取回并 junction 进来；
不 vendor，所以你拿到的是他们当前的代码，著作权也归他们。其中两个文件在本地打了补丁，因为它原本
只面向 NX 12：`SKILL.md` 现在按版本列出解释器，而不是把 3.6.1 当成事实；`check_journal.py` 接受
目标版本（`--python-version`、`--print-python`），而不是无条件把 3.8+ 的 API 判成错误。这两处补丁
只在本机，没有合进上游。

**其余部分**——执行器、探测、安装器、MCP 行、示例——都是本仓库写的。同样的划分（带 commit 与许可证
路径）也写在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 验证方式

| | NX 12.0.0.27 | NX 2406.1700 |
|---|---|---|
| 五个 in-NX 模块能导入 | 3.6.1 | 3.10 |
| 桥能起、`nx_status` 有回应 | `connected: true`，`v12` | `connected: true`，`v2406` |
| 16 个工具 | 全过 | 全过 |
| `examples/a_model.py` | — | 通过，写出 `.prt` |
| `examples/b_drawing.py` | — | 17.9 秒；`.prt` 204 KB、`.pdf` 48 KB、`.stl` 67 KB |

判定逻辑在 2406 上对着四个 journal 验过。每一个都必须让同一条代码路径给出不同的答案，否则这套逻辑
等于没做事：

| journal | 期望 | 实际 |
|---|---|---|
| `examples/smoke.py` | ok | ok，10.1 秒，退出码 `0xC0000409` 按干净处理 |
| 故意抛异常 | fail | `uncaught exception (exit 1)` |
| 接住异常但跑完 | 先 fail，后 ok | 默认是 fail 原因；加 `--allow-traceback` 变 warning |
| `sleep` 超过 `--timeout 5` | fail | `timeout … killed 4 process(es)`，7.2 秒返回 |

复跑第一条：

```powershell
dsh-nx run-journal examples\smoke.py --expect SMOKE_OK --json
```

CI 不需要 NX：移植后的源码按 3.6 / 3.10 / 3.12 三套语法解析；五个 in-NX 模块能导入并建出 dataclass；
探测对每种解释器的假安装都能报出正确的支持档位。

## 许可证

MIT，Copyright (c) 2026 27painter —— 见 [LICENSE](LICENSE)。两个上游，一个 vendor、一个安装时拉取；
各自是什么、改了什么，记在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
