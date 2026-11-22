# Antigravity ACP for DSH

在 DSH 里用 Google Antigravity 作为模型：**模型生成走官方 ACP，工具执行仍归 DSH**（校验、审批、执行，再把结果回填给模型）。

## 致敬原作者

本项目 fork 自 [KouzakiUmi/dsh-antigravity-acp](https://github.com/KouzakiUmi/dsh-antigravity-acp)（作者 **KouzakiUmi**，npm 包 `dsh-bundle-antigravity-host`）。把 Antigravity 的 ACP 接进 DSH、做登录态导入、额度、代理模式与整套测试，都是原作者的工作。

本 fork 只在此基础上做了这些改动：

- 修复官方包解压上限（官方 1.4.0 包解压后约 1.06 GB，原上限会误拦）与 zip 执行位丢失
- Linux 上给 ACP 进程加 bwrap 沙箱（默认开）：home 只暴露 `~/.gemini` 与安装目录，系统目录只读，网络保留
- 设置页「agy CLI 登录」一键登录；授权链接自动打开，登录进程同样在沙箱里，keyring 走按需的受限 D-Bus 代理
- 新增 `agentCommand: "cli"`，可直接用官方 `agy acp` 作为后端
- 沙箱下会话工作目录落在 `<安装根>/workspace`（真实项目目录在沙箱内不可见）

## 功能

- **模型**：在 DSH 模型选择器里选 `Antigravity (ACP)`，生成走官方 ACP server。
- **工具**：工具 schema 由 DSH 通过私有 loopback MCP 桥提供，执行与审批都在 DSH 侧；官方 agent 的内置工具被关闭。
- **后端**：默认官方 `agy_acp_server.par`（自动下载、校验后解压）；也可切 `agy acp`（官方 CLI）。
- **登录**：导入本机官方 CLI 登录态，或在设置页一键登录（浏览器 + 粘贴 code）。
- **额度**：模型选择器旁的额度药丸。ACP 模式走内置直连；打开 `cliQuotaEnabled` 后改走本机 `agy -p /usage` 与 `/credits`。
- **沙箱**：Linux 默认用 bwrap 启动官方进程，缺 bwrap 时拒绝启动而不是裸跑。

## 安装

```console
dsh plugin --profile web add github:sunnyyangyangyang/dsh-antigravity-acp#feat/bwrap-sandbox-zip-limits
```

如果 CLI 不接受 git 依赖，就在 profile 目录手动装：

```console
cd ~/.dsh/profiles/web
pnpm add github:sunnyyangyangyang/dsh-antigravity-acp#feat/bwrap-sandbox-zip-limits
```

并把 `dsh-bundle-antigravity-host` 加进该 `package.json` 的 `dsh.profile.bundles`。装完重启 dsh。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `agentCommand` | `"par"` | `par` = 官方 `.par`（默认）；`cli` = 官方 `agy acp`，需 `binaryPath` 指向 agy |
| `binaryPath` | 未设置 | 本地 ACP 可执行文件；留空按 `AGY_ACP_BIN` → 缓存 → 自动下载 |
| `sandbox` | `true` | Linux 上用 bwrap 关住官方进程；非 Linux 忽略 |
| `bwrapPath` | 未设置 | bwrap 路径；留空查 `AGY_ACP_BWRAP` 与 PATH |
| `cliQuotaEnabled` | `false` | 用 `agy -p /usage`、`/credits` 查额度（AI Credits 仅此路径） |
| `agyCliPath` | 未设置 | 官方 `agy` 路径，用于额度与设置页登录 |

环境变量：`AGY_ACP_BIN`、`AGY_ACP_HOME`、`AGY_ACP_BWRAP`、`AGY_ACP_NO_SANDBOX`（紧急关闭沙箱）。

## 登录与额度

设置 → Antigravity ACP → 连接：

- `.par` 后端：点「连接 / 登录 ACP」，授权链接会自动用宿主浏览器打开，回调走 `127.0.0.1`。
- `agy` 后端或想共用 CLI 登录态：用「agy CLI 登录」面板，点开始登录 → 浏览器打开 → 把 code 贴回面板。
- 额度：账号没有 Gemini Code Assist 订阅时，内置直连会拿不到数字；`cliQuotaEnabled` 走 CLI，需要先完成 agy 登录。

## 已知边界

- `agy acp` 的 ACP 实现没有声明 MCP 能力，DSH 的工具桥在它上面不可用（工具轮次会空回复），所以默认仍用 `.par`；要用 CLI 工具需要 `--ide-mcp-port` 方向的适配。
- 沙箱只读挂载 `/usr`、`/etc`、`/sys` 等系统目录；home 只暴露 `~/.gemini` 与安装根，其它路径不可见。
- 登录进程与 ACP 进程分离：登录进 bwrap、keyring 只经 `xdg-dbus-proxy` 放行 `org.freedesktop.secrets`，结束后回收。

## 致谢与许可

再次感谢原作者 [KouzakiUmi](https://github.com/KouzakiUmi) 的上游实现与文档。上游仓库：<https://github.com/KouzakiUmi/dsh-antigravity-acp>。

MIT License，见 [LICENSE](LICENSE)。
