# iCloud Desk

**[English](README.md) | 简体中文**

iCloud Desk 是 Windows 上的非官方 iCloud 桌面客户端，界面仿照 iCloud 网页版。支持日历、提醒事项、备忘录（可写）、iCloud 云盘、照片、通讯录、查找、隐藏邮件地址和账户管理。

- **一次登录，长期保持**：使用 Apple ID 密码与双重认证登录一次后长期保持信任会话。
- **原生桌面体验**：C# .NET 8 + WebView2 原生窗口，带开始菜单入口、“应用和功能”卸载项、系统托盘常驻与全局快捷键。
- **多语言界面**：内置**简体中文**与 **English**，默认跟随系统语言，可在界面内实时切换。
- **Agent 友好的 `icd` CLI**：所有核心模块均可通过 JSON 读写，共享桌面登录会话，方便脚本与其他 AI Agent 调用。

## 安装

1. 从 [GitHub Releases](https://github.com/CanderFlower/icloud-desk/releases) 下载 `iCloudDesk-Setup-<版本>.exe`（或自行构建 `dist\iCloudDesk-Setup-<版本>.exe`）并运行。按当前用户安装，不需要管理员权限。
   - 安装位置：`%LOCALAPPDATA%\Programs\iCloud Desk`。
   - 会添加开始菜单快捷方式、卸载项，以及 App Paths 注册（`Win+R` 里输入 `iCloudDesk` 或 `icd` 都能启动）。
   - 安装向导自动匹配中文/英文界面；默认勾选“把 `icd` 加入 PATH”（需新开终端生效）。
2. 打开 iCloud Desk，登录并完成双重认证。
3. 静默安装命令：`iCloudDesk-Setup-x.y.z.exe /VERYSILENT /TASKS=addtopath`

需要 Edge WebView2 运行时，Windows 10 和 11 一般已经自带。

### 窗口与托盘

- 点关闭（或 `Alt+F4`）默认隐藏到系统托盘，不退出。右键托盘图标可以“退出”，或取消勾选“关闭窗口时隐藏到托盘”。
- 全局快捷键 `Ctrl+Alt+R` 用来显示或隐藏窗口。如果该快捷键已被其他程序占用，托盘菜单里会显示“（被占用）”。
- 再次启动程序（开始菜单或 `iCloudDesk`）会把已隐藏的窗口唤出来。

### 多语言支持（简体中文 / English）

- **自动检测与实时切换**：默认跟随操作系统 / 浏览器语言（中文环境显示简体中文，其他环境显示 English）。
- **界面切换**：登录页右上角地球图标，或登录后左下角账户菜单中的“语言 / Language”，可在 `跟随系统`、`简体中文`、`English` 之间无刷新实时切换。
- **全栈联动**：切换语言后，前端界面、日期格式、Windows 原生托盘菜单、错误提示页及本地服务返回的提示信息会同步更新并持久化保存。
- **命令行语言**：`icd` 默认跟随系统语言，也可通过 `--lang zh` / `--lang en` 或环境变量 `ICD_LANG=en` 指定提示语言。

### 本地缓存

日历、提醒事项、备忘录列表和云盘目录会保留本地快照，切换页面、重新打开窗口时先显示缓存，不必每次等 Apple 返回数据。缓存超过一分钟会在后台同步；刷新按钮或 `F5` 始终读取最新数据，同步失败会提示并保留已有内容。

缓存按 Apple 账户及中国大陆/国际区隔离，最多保留七天，写入后失效，退出登录会清除。缓存只用于查看，不会离线排队提交修改；备忘录正文仍从服务读取后才能编辑。首次访问未缓存的内容仍需联网加载。桌面窗口启动时也会直接复用已经运行的本地服务，避免重复启动命令行组件。

## 命令行（给 Agent 用）

```powershell
icd guide                       # 完整用法，把这段输出交给 Agent 就够了
icd calendar events --days 7
icd calendar add --title "开会" --start "tomorrow" --duration 60 --calendar 个人
icd reminders add --title "交报告" --due +2d --priority high
icd notes add --folder 备忘录 --text "标题`n- [ ] 待办一`n正文"
icd notes get <ID> --format markdown
icd drive upload .\a.pdf --to /Documents
icd api GET /api/account        # 直接调用任意 HTTP 接口
```

- **输出格式**：结果以 JSON 写到 stdout，错误以 `{"error": ...}` 写到 stderr。
- **退出码**：

  | 退出码 | 含义 |
  |---|---|
  | 0 | 成功 |
  | 1 | 错误 |
  | 2 | 参数错误 |
  | 3 | 未登录 |
  | 4 | 未找到 |
  | 5 | 冲突或已锁定 |

- **常用选项**：`--compact` 输出单行 JSON；`--ascii` 把非 ASCII 字符转义；`--demo` 使用演示数据；`--lang {auto,zh,en}` 指定提示语言。
- **后台服务**：CLI 会自动启动后台服务 `icd daemon`，它和桌面窗口共用同一个登录会话。
- **中文乱码**：如果管道里的中文显示成乱码，设置 `$env:ICD_UTF8=1`，或者使用 `--ascii`。

## 功能

| 模块 | 能力 |
|---|---|
| 日历 | 读写：月、周、日、列表视图，拖拽调整，新建、编辑、删除日程，日历管理 |
| 提醒事项 | 读写：列表、智能列表、行内编辑、完成、截止时间、优先级、旗标、子任务 |
| 备忘录 | 读写：文件夹树、富文本块级编辑（标题、列表、清单、粗体斜体、代码块、链接）、自动保存、最近删除与恢复；锁定的备忘录只读 |
| iCloud 云盘 | 读写：Finder 风格的图标和列表视图，拖拽上传、新建文件夹、重命名、移动、最近删除、空格快速查看 |
| 照片 | 读写：图库与相簿、按日等高网格、大图查看器、收藏、拖拽上传、删除、下载原件 |
| 通讯录 | 只读：支持中英文拼音首字母索引分组、生日提醒、vCard 导出 |
| 查找 | 设备列表、电量、地图定位、播放声音、发送信息、丢失模式 |
| 隐藏邮件地址 | 生成随机地址、新建、编辑标签与备注、停用/启用、永久删除 |
| 账户 | 用户资料、iCloud 储存空间分布、登录设备、家人共享 |

备忘录写入功能基于 iCloud 网页版同款的 CloudKit 与 CRDT/protobuf 格式实现（位于 `app/notes_*.py`）。保存时会校验 `recordChangeTag`，若已在其他设备修改会提示冲突。

## 登录说明

- **App 专用密码不能登录 iCloud 网页服务。** 它只能用于 CalDAV、CardDAV 和 IMAP，所以这里必须用 Apple ID 主密码加双重认证码登录。
- 会话保存在 `%APPDATA%\icloud-desk`，可以用环境变量 `ICLOUD_DESK_HOME` 改位置。
- 勾选“保持登录”后，密码会存进 Windows 凭据管理器。会话过期时程序会自动重新登录，只有 Apple 要求重新做双重认证时才需要你操作。
- 中国大陆账户请勾选“中国大陆 iCloud 账户”（使用 `icloud.com.cn`）。

## 架构

```
iCloudDesk.exe  (shell/)       C# .NET 8 + WebView2 外壳，负责自定义标题栏、托盘、快捷键和单实例
      │ 启动或直接复用
      ▼
icd.exe daemon  (app/, PyInstaller)
      每个用户一个本地 HTTP 服务（127.0.0.1，Bearer/Cookie token 鉴权）
      FastAPI + pyicloud，托管 web/ 前端并按 Accept-Language 返回多语言消息
      ▲
icd.exe <command>  (app/cli.py)  命令行，通过同一个后台服务读写
```

| 路径 | 内容 |
|---|---|
| `app/daemon.py` | 后台服务的启动、发现和停止（`%APPDATA%\icloud-desk\daemon.json`） |
| `app/i18n.py` | 后端与 CLI 多语言上下文（`zh-CN` / `en`） |
| `app/server.py`、`app/routes/*.py` | REST 接口 `/api/<模块>/...` |
| `app/demo.py` | 演示模式内存假数据（随语言切换中英文示例数据） |
| `web/` | 无需构建的原生 ES Module 前端 |
| `web/styles.css`、`web/css/<模块>.css` | 设计系统与各模块样式 |
| `web/js/i18n.js` | 前端多语言状态、文本与复数辅助函数 |
| `web/js/cache.js` | 账户隔离的本地快照缓存与后台重验证 |
| `web/js/ui.js` | 通用组件库：modal、menu、popover、toast、icon、日期格式化 |
| `web/js/modules/*.js` | 各功能模块，格式为 `export default { id, get title(), app, mount(el) }` |
| `web/assets/icons.svg` | Lucide 图标 sprite，用 `scripts/build_icons.py` 生成（清单见 `web/assets/icons.txt`） |
| `web/assets/apps/` | iCloud 应用图标 |
| `shell/` | C# WinForms + WebView2 桌面外壳（含 `shell/I18n.cs` 原生托盘与提示多语言） |

## 开发

```bat
run.bat                         :: 首次运行自动创建 .venv，并在浏览器打开（真实账户）
run.bat --demo ui               :: 演示数据模式，无需登录即可预览和调试中英文 UI
run.bat --demo daemon restart   :: 修改 Python 后端后重启本地服务
.venv\Scripts\python -m pytest  :: 运行后端与备忘录编解码、缓存、多语言测试
node --test tests\*.test.mjs    :: 运行前端缓存与多语言单元测试
```

前端无需构建步骤，改完刷新页面即可生效。

### 打包

需要准备：

- Python 3.11 及以上
- .NET 8 SDK
- [Inno Setup 6](https://jrsoftware.org/isdl.php)
- `pip install -r requirements-build.txt`

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1            # 完整构建，生成 dist\iCloudDesk-Setup-x.y.z.exe
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipShell # 只重新打包 Python 部分
```

版本号定义在 `app/__init__.py` 中。

## 已知限制

- 备忘录：含附件、表格或绘图的备忘录默认只读。可以强制保存（UI 点“仍然编辑”或 CLI 加 `--force`），但附件会被移除。
- 通讯录目前为只读。
- 日历：重复日程和受邀日程目前只能查看。
- 底层接口基于 [pyicloud](https://github.com/timlaing/pyicloud)；Apple 调整网页端协议时可能需要升级依赖并重新打包。

## 开源协议与声明

- 本项目基于 [MIT License](LICENSE) 开源。
- 本项目为非官方第三方客户端，与 Apple Inc. 无关；iCloud 及相关服务名称、应用图标归 Apple Inc. 所有，界面通用图标来自 [Lucide](https://lucide.dev/)（ISC License）。
