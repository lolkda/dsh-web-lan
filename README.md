# @lolkda/dsh-web-lan

让 `dsh web` 能被局域网 / 虚拟局域网（SD-WAN、Tailscale、ZeroTier、旁路由组网）里的其他设备访问，**不需要任何额外命令行参数**。

装一次，以后照常启动：

```powershell
dsh web
```

## 它解决什么

`dsh web` 默认只监听 `127.0.0.1`，本机之外一律连不上。官方把改 bind 的开关锁死了两处：

| 位置 | 内容 |
|---|---|
| `dsh-web-app/lib/startup.js:40` | 显式拒绝 `--host 0.0.0.0` |
| `dsh-host-webserver/lib/index.js:141` | `host` 的 schema 只接受 `'127.0.0.1' \| '0.0.0.0'` |

所以 `--host 192.168.1.5` 会通过 CLI、然后死在校验上；`--host 0.0.0.0` 直接被拒。官方这样设是因为这个面板等价于**本机任意命令执行**。

本包的做法是保留官方默认姿态，把它变成一个显式选择：**装了就开，卸了就回到 loopback。**

## 访问需要的几个环节

1. **bind** —— patch 层把 webserver 行的 `host` 设成 `0.0.0.0`。只能从 patch 层进，因为 CLI 和 schema 两道护栏。
2. **`/api` 的 Host 白名单** —— fence 要求 `Host` 是 loopback 或命中 `trustedHosts`，而 dsh 只在 bind 恰好是 `0.0.0.0` 时才派生 LAN 字面量。本包把 bind 打开后本机 IP 自动可信，另外支持用 `DSH_WEB_TRUSTED_HOSTS` 追加域名（远端用域名/旁路由发布名访问时必需）。
3. **启动 token** —— token 只在内存里（`randomBytes(32)`，不落盘），但它换来的浏览器 cookie 是用 `$DSH_HOME/.credentials.yaml` 里持久化的密钥签名的，**能跨 dsh 重启存活**。本包把有效期从 30 天拉到 10 年，等于每台设备只需要带一次 token。

4. **远程设置** —— 0.1.1 起修复 LAN 模型页的 `settings are unavailable in this browser`：通过公开插件接口提供宿主设置数据，不改 DSH 本体。

## 安装

```powershell
dsh plugin --profile web add /absolute/path/lolkda-dsh-web-lan-0.2.0-rc.1.tgz
```

`dsh plugin add` 会做一件事：因为本包声明了 `dsh.bundle.patch`，CLI 的 `reconcilePlugins` 会把它追加进 profile 的 `dsh.profile.bundles` —— 于是这一层成为**每次启动的一部分**，不再需要 `--patch`。

本地适配版 `0.2.0-rc.1` 面向 DSH `0.1.7-rc.1`，客户端使用新版 `configForms`（不再使用已删除的 `settingsScope`）；读取、保存、卸载恢复与权限检查保持原契约，写入拒绝返回 `false`。回归测试固定使用该 DSH 版本，未对未经验证的新 DSH 版本放开版本门禁。更新本目录不会自动替换先前安装的副本，需要重新打包安装。

装完重启 `dsh web`，并刷新浏览器。启动行会按网卡逐个打印可用地址：

```
dsh-web-lan: reachable on 0.0.0.0:3080 within 家用局域网 / 虚拟局域网 / VPN
dsh-web-lan:   192.168.1.5     http://192.168.1.5:3080/?token=...
dsh-web-lan:   172.30.226.31   http://172.30.226.31:3080/?token=...
```

这修掉了上游的一个坑：`dsh-web-app` 只打印 `lanAddresses[0]`，也就是 `os.networkInterfaces()` 枚举到的第一个地址 —— 在有虚拟网卡的机器上经常是错的那个。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoLogin` | `false` | `true` 时注册一个免 token 入口，任何能连到这个端口的人打开它都会被自动发放会话 |
| `bootstrapPath` | `/go` | 免 token 入口的路径。注册在 webserver 的 `exact` 表，优先级高于 frontend-static 占的 `fallback` 座位 |
| `printLanUrls` | `true` | 启动时按网卡打印可达地址 |
| `remoteSettings` | `true` | 为已登录的 LAN 浏览器恢复模型与命名空间设置；只在全接口监听时启用 |

### 免 token 入口（`autoLogin: true`）

打开 `http://192.168.1.5:3080/go` 即可进入，不需要 token。它做的事是 303 重定向到 `connection.authenticatedUrl(...)` —— 这是公开读取本进程启动 token 的唯一途径。

> **这是把这条网段上的鉴权去掉。** 只在你完全信任的网段（家用 LAN、自建 VPN）上打开。

修改配置：改 profile 自己的 `cordis.patch.yml`（它在 bundle 层之后应用），用 id 定向：

```yaml
- id: dsh-web-lan
  name: '@lolkda/dsh-web-lan'
  config:
    autoLogin: true
```

### LAN 模型设置（`remoteSettings: true`）

0.1.1 增加了浏览器插件部分。官方设置服务会把非本机页面切到内存模式，模型页却需要宿主设置，因此显示 `settings are unavailable in this browser`。本插件通过 Cordis Loader 的公开服务隔离与启停接口，让原有页面使用本插件提供的宿主设置服务。

- **不修改 DSH 的任何安装文件，不替换官方脚本，不改变全局 `isLoopback`。**
- 所有读取、保存仍调用原有的设置 RPC，服务端登录、Host/Origin 和写权限检查照旧。
- 本机地址访问保留官方服务；正常卸载浏览器插件时恢复原服务。安装/卸载整个包后应重启 DSH 并刷新页面。
- 修改的是宿主共享配置，不是当前浏览器自己的副本。开启 `autoLogin` 的设备也能使用这些设置。
- 不会额外开放通用设置中的本机原始文档编辑/打开功能；这些仍遵守上游自己的本机限制。
- 若手工移除并重新添加官方设置基础插件，需要刷新页面重新建立服务关系；不会强行接管用户自定义的隔离服务。

如需保留 LAN 访问、仅停用设置修复，在 profile 的补丁层为本插件设置：

```yaml
- id: dsh-web-lan
  name: '@lolkda/dsh-web-lan'
  config:
    remoteSettings: false
    # 若原先打开了 autoLogin，需要同时保留 autoLogin: true。
```

该开关在首页生成时传给浏览器，修改后重启 DSH 并刷新页面生效。

### 临时回到只本机

```powershell
$env:DSH_WEB_LOOPBACK='1'; dsh web
```

## 卸载

```powershell
dsh plugin --profile web remove @lolkda/dsh-web-lan
```

`reconcilePlugins` 会把它从 `dsh.profile.bundles` 移出，回到 loopback-only。

## 已知边界

- **`0.0.0.0` 是"所有网卡"** —— 它会在虚拟网卡（VPN、Hyper-V、SD-WAN）上一并监听。想只开某一块网卡需要另起 listener 做反代，本包不做。
- **不改宿主正在运行的监听配置** —— bind 是组合期配置，所以「装/卸」需要重启 `dsh web`。想要网页里的运行时开关得驱动 loader，代价是重新 listen、断开当前连接。
- **上游升级可能改变假设** —— 本包依赖 `webserver` / `connection` 这两个行 id，以及 `/api` fence 的行为。`dsh-web-lan` 挂载时会检查实际 bind，被后续 patch 层覆盖时会打 warn 而不是打印不可达的地址。
- **零运行依赖、无需构建** —— 宿主只 import `node:os`；浏览器使用 DSH 的标准模块注册格式，从宿主页面提供的模块表获取 Cordis。裸 checkout 的 `link:` 加载不依赖本地 `node_modules`。测试有锁定的开发依赖。

## 测试

```powershell
npm ci --ignore-scripts
npm run check
```

回归测试在独立内存环境中运行未经修改的官方设置和模型页控制器，以及真实 Cordis/Loader 生命周期，覆盖原始报错、LAN 恢复、本机不受影响、卸载恢复、失败回滚、并发保存、过期响应、推送更新与重载。不连接正在运行的 DSH，也不读取或改写用户配置；这不等同于已在你的远端浏览器完成现场验收。

## 发布

推一个 `v*` 标签即发布，也可以手动触发 `.github/workflows/publish.yml` 重跑。整条流水线只有一条路径：**测试 → 闸门 → 打包 → 上传 artifact → 发布刚打出来的那个 tarball**，所以发出去的字节就是 CI 里跑过测试、并在 run artifact 里留档的那一份。

```powershell
git tag v0.2.0-rc.1
git push origin v0.2.0-rc.1
```

闸门逻辑在 `scripts/release.mjs`（单测在 `test/release.test.js`），不写在 YAML 里：

- 标签版本必须等于 `package.json` 的 `version`（打错标签不会静默发错版本）；
- 该版本已存在于 registry 则直接失败（npm 同一版本不可覆盖）；
- **dist-tag 由版本决定**：`0.2.0-rc.1` 这类预发布走 `next`，只有正式版走 `latest`。npm ≥ 11 对预发布强制要求显式 `--tag`，而它的默认值是 `latest` —— 让 rc 变成 `latest` 会把未定版通过 `dsh plugin add @lolkda/dsh-web-lan` 发给所有人。

凭据用 **npm Trusted Publishing（OIDC）**：仓库里不放任何长期 token，CI 用 GitHub 的短时 id-token 找 npm 换一次性发布凭据。发布前需要在 npmjs.com 登记一次本工作流（**包设置 → Trusted Publisher → GitHub Actions**）：

| 字段 | 值 |
| --- | --- |
| Organization or user | `lolkda`（仓库所有者） |
| Repository | `dsh-web-lan` |
| Workflow filename | `publish.yml`（只写文件名，不要路径） |
| Environment name | 留空 |
| Allowed actions | 勾上**直接发布**（`npm publish`）；2026-09-03 之后新建的配置默认只允许 `npm stage publish` |

没登记就发布的话，`npm publish` 会以 `ENEEDAUTH` 失败 —— 那是配置缺失，不是脚本问题。Trusted Publishing 要求 npm CLI ≥ 11.5.1 / Node ≥ 22.14.0，工作流里因此显式升了一次 npm（runner 上 Node 22 自带 npm 10.x）。npm 侧还可以打开包设置的 *Require two-factor authentication and disallow tokens*，那样连长期 token 都发不了，与 OIDC 正好配套。

装 rc 时客户端要显式指定版本号：`dsh plugin --profile web add @lolkda/dsh-web-lan@0.2.0-rc.1`。

本地想先看一眼要发什么（不发布）：

```powershell
npm pack --pack-destination dist          # dist/lolkda-dsh-web-lan-<version>.tgz
npm publish ./dist/*.tgz --tag next --dry-run
```

