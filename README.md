# iCloud Desk

在 Windows 上使用 iCloud 的桌面客户端，界面仿 iCloud 网页版。登录一次（Apple ID 密码 + 双重认证）后会长期保持会话，不用反复登录。

## 运行

```bat
run.bat              :: 首次运行会自动创建 .venv 并安装依赖，然后打开桌面窗口
run.bat --browser    :: 在默认浏览器中打开
run.bat --demo       :: 演示模式（假数据，不需要登录，适合改 UI）
run.bat --server     :: 只启动 HTTP 服务（http://127.0.0.1:8848）
run.bat --port 9000 --debug
```

需要 Python 3.10+，以及 Windows 自带的 Edge WebView2 运行时。

## 功能

| 模块 | 能力 |
|---|---|
| 日历 | 读写：月视图、周视图，新建/编辑/删除日程，新建/删除日历 |
| 提醒事项 | 读写：列表、新建、完成、编辑（截止时间、优先级、旗标）、子任务、删除 |
| 备忘录 | 只读：文件夹、搜索、正文、附件下载（pyicloud 不支持写入） |
| iCloud 云盘 | 读写：浏览、上传（支持拖拽）、新建文件夹、重命名、移动、废纸篓与恢复、下载 |
| 照片 | 读写：相簿、无限滚动、大图查看、收藏、上传、删除、下载原图 |
| 通讯录 | 只读 |
| 查找 | 设备列表、电量、地图位置、播放声音、发送信息、丢失模式 |
| 隐藏邮件地址 | 新建、编辑、停用/启用、删除、复制 |
| 账户 | 用户信息、存储空间、设备、家庭共享 |

## 登录说明

- **App 专用密码不能用来登录 iCloud 网页服务**，它只能用于 CalDAV、CardDAV、IMAP。所以这里用 Apple ID 主密码加双重认证码登录。
- 会话 Cookie 保存在 `%APPDATA%\icloud-desk\session`（可以用环境变量 `ICLOUD_DESK_HOME` 改位置），有效期内重启不需要再验证。
- 勾选“在 Windows 凭据管理器中保存密码”后，密码会保存在 **Windows 凭据管理器**里。会话过期时会自动静默重新登录，只有 Apple 要求重新做双重认证时才需要你操作。
- 中国大陆的 Apple ID 请勾选“中国大陆 iCloud 账户”（使用 icloud.com.cn）。
- 不支持硬件安全密钥（FIDO2）登录。

## 架构

```
main.py              启动器：uvicorn 后台线程 + pywebview 窗口
app/
  icloud.py          登录、双重认证、会话恢复、自动重新登录（icloud.call 封装）
  server.py          FastAPI 应用；演示模式下挂载 demo.py
  demo.py            内存假数据，接口结构和真实路由一致
  routes/*.py        每个服务对应一个 REST 路由（/api/calendar、/api/drive …）
web/
  index.html, styles.css
  js/api.js          fetch 封装（遇到 401 时触发 auth-required 事件）
  js/ui.js           h() 建 DOM、modal、toast、confirm 等小工具
  js/main.js         登录流程、侧边栏、hash 路由
  js/modules/*.js    每个功能一个模块：export default { id, title, icon, color, mount(el) }
```

前端不需要构建，改完刷新即可。用 `run.bat --demo --browser` 调 UI 最方便。

### 新增一个模块

1. 在 `app/routes/` 写路由，通过 `icloud.call(lambda api: ...)` 访问 pyicloud，然后在 `server.py` 里注册。
2. 在 `app/demo.py` 补对应的假数据（可选）。
3. 在 `web/js/modules/` 新建模块，并加到 `main.js` 的 `MODULES` 数组里。

## 已知限制 / 待真机验证

- 日历：编辑重复日程、受邀日程时只能查看；更新接口和全天日程的结束日期还需要用真实账号验证。
- 备忘录、通讯录是只读的（受 pyicloud 能力限制）。
- 数据来源于 [pyicloud](https://github.com/timlaing/pyicloud)，Apple 改接口时可能需要升级：`.venv\Scripts\pip install -U pyicloud`。
