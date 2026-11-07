# iCloud Desk

iCloud Desk 是 Windows 上的 iCloud 桌面客户端，界面仿照 iCloud 网页版。它支持日历、提醒事项、备忘录（可写）、iCloud 云盘、照片、通讯录、查找、隐藏邮件地址和账户。

- 只需登录一次（Apple ID 密码加双重认证），之后会长期保持会话。
- 安装包会把它注册为正式的 Windows 程序，带开始菜单入口和“应用和功能”里的卸载项。
- 附带 `icd` 命令行工具，所有功能都能用 JSON 读写，方便其他 AI Agent 调用。

## 安装

1. 运行 `dist\iCloudDesk-Setup-<版本>.exe`。按当前用户安装，不需要管理员权限。
   - 安装位置：`%LOCALAPPDATA%\Programs\iCloud Desk`。
   - 会添加开始菜单快捷方式、卸载项，以及 App Paths 注册（`Win+R` 里输入 `iCloudDesk` 或 `icd` 都能启动）。
   - 默认勾选“把 `icd` 加入 PATH”。需要新开一个终端才会生效。
2. 打开 iCloud Desk，登录并完成双重认证。
3. 静默安装命令：`iCloudDesk-Setup-x.y.z.exe /VERYSILENT /TASKS=addtopath`

需要 Edge WebView2 运行时，Windows 10 和 11 一般已经自带。

### 窗口与托盘

- 点关闭（或 Alt+F4）默认隐藏到系统托盘，不退出。右键托盘图标可以“退出”，或取消勾选“关闭窗口时隐藏到托盘”。
- 全局快捷键 `Ctrl+Alt+R` 用来显示或隐藏窗口。如果这个快捷键已经被别的程序占用，托盘菜单里会显示“（被占用）”。
- 再次启动程序（开始菜单或 `iCloudDesk`）会把已隐藏的窗口唤出来。

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

- **常用选项**：`--compact` 输出单行 JSON；`--ascii` 把非 ASCII 字符转义；`--demo` 使用假数据。
- **后台服务**：CLI 会自动启动后台服务 `icd daemon`，它和桌面窗口共用同一个登录会话。
- **中文乱码**：如果管道里的中文显示成乱码，设置 `$env:ICD_UTF8=1`，或者使用 `--ascii`。

## 功能

| 模块 | 能力 |
|---|---|
| 日历 | 读写：月、周、日视图，新建、编辑、删除日程，日历管理 |
| 提醒事项 | 读写：列表、智能列表、新建、完成、截止时间、优先级、旗标、子任务 |
| 备忘录 | 读写：文件夹、富文本编辑（标题、列表、清单、粗体斜体）、自动保存、最近删除与恢复；锁定的备忘录只能查看 |
| iCloud 云盘 | 读写：Finder 风格的网格和列表视图，上传、新建、重命名、移动、废纸篓、快速查看 |
| 照片 | 读写：相簿、大图、收藏、上传、删除、下载原图 |
| 通讯录 | 只读 |
| 查找 | 设备、电量、地图、播放声音、发送信息、丢失模式 |
| 隐藏邮件地址 | 新建、编辑、停用、删除 |
| 账户 | 用户信息、存储空间、设备 |

备忘录写入功能是自己实现的：它使用 iCloud 网页版同款的 CloudKit 和 CRDT/protobuf 格式，代码在 `app/notes_*.py`。保存时会检查版本，如果在别的设备上改过，会提示冲突。

## 登录说明

- **App 专用密码不能登录 iCloud 网页服务。** 它只能用于 CalDAV、CardDAV 和 IMAP，所以这里必须用 Apple ID 主密码加双重认证码登录。
- 会话保存在 `%APPDATA%\icloud-desk`，可以用环境变量 `ICLOUD_DESK_HOME` 改位置。
- 勾选“记住密码”后，密码会存进 Windows 凭据管理器。会话过期时程序会自动重新登录，只有 Apple 要求重新做双重认证时才需要你操作。
- 中国大陆账户请勾选“中国大陆 iCloud”（会使用 icloud.com.cn）。

## 架构

```
iCloudDesk.exe  (shell/)       C# .NET 8 + WebView2 外壳，负责窗口、托盘和单实例
      │ 启动或复用
      ▼
icd.exe daemon  (app/, PyInstaller)
      每个用户一个本地 HTTP 服务（127.0.0.1，用 token 鉴权）
      FastAPI、pyicloud，并负责托管 web/ 前端
      ▲
icd.exe <command>  (app/cli.py)  命令行，通过同一个后台服务读写
```

| 路径 | 内容 |
|---|---|
| `app/daemon.py` | 后台服务的启动、发现和停止（`%APPDATA%\icloud-desk\daemon.json`） |
| `app/server.py`、`app/routes/*.py` | REST 接口 `/api/<模块>/...` |
| `app/demo.py` | 演示模式用的内存假数据，接口结构和真实接口一致 |
| `web/` | 无需构建的 ES Module 前端 |
| `web/styles.css` | 设计系统 |
| `web/css/<模块>.css` | 各模块样式 |
| `web/js/ui.js` | 组件库：modal、menu、toast、icon 等 |
| `web/js/modules/*.js` | 功能模块，格式为 `export default { id, title, app, mount(el) }` |
| `web/assets/icons.svg` | Lucide 图标 sprite，用 `scripts/build_icons.py` 生成，图标名写在 `icons.txt` |
| `web/assets/apps/` | iCloud 应用图标 |

## 开发

```bat
run.bat                    :: 第一次运行会自动创建 .venv，然后在浏览器打开（真实账户）
run.bat --demo ui          :: 演示数据，不需要登录，适合改 UI
run.bat --demo daemon restart   :: 改了 Python 后端后需要重启服务
.venv\Scripts\python -m pytest
```

前端改完直接刷新页面就能看到效果。

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

版本号写在 `app/__init__.py` 里。

## 已知限制

- 备忘录：含附件、表格或绘图的备忘录默认只读。可以强制保存（CLI 加 `--force`），但这些内容会丢失。
- 通讯录目前只读。
- 日历：重复日程和受邀日程只能查看。
- 数据来自 [pyicloud](https://github.com/timlaing/pyicloud)。Apple 改接口时可能需要升级 pyicloud 并重新打包。
