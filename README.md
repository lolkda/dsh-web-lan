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

## 三个层次的问题，一次解决

1. **bind** —— patch 层把 webserver 行的 `host` 设成 `0.0.0.0`。只能从 patch 层进，因为 CLI 和 schema 两道护栏。
2. **`/api` 的 Host 白名单** —— fence 要求 `Host` 是 loopback 或命中 `trustedHosts`，而 dsh 只在 bind 恰好是 `0.0.0.0` 时才派生 LAN 字面量。本包把 bind 打开后本机 IP 自动可信，另外支持用 `DSH_WEB_TRUSTED_HOSTS` 追加域名（远端用域名/旁路由发布名访问时必需）。
3. **启动 token** —— token 只在内存里（`randomBytes(32)`，不落盘），但它换来的浏览器 cookie 是用 `$DSH_HOME/.credentials.yaml` 里持久化的密钥签名的，**能跨 dsh 重启存活**。本包把有效期从 30 天拉到 10 年，等于每台设备只需要带一次 token。

## 安装

```powershell
dsh plugin --profile web add link:F:/project/dsh-web-lan
```

`dsh plugin add` 会做一件事：因为本包声明了 `dsh.bundle.patch`，CLI 的 `reconcilePlugins` 会把它追加进 profile 的 `dsh.profile.bundles` —— 于是这一层成为**每次启动的一部分**，不再需要 `--patch`。

装完重启 `dsh web`。启动行会按网卡逐个打印可用地址：

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
- **不改任何运行中的行** —— bind 是组合期配置，所以「装/卸」需要重启 `dsh web`。想要网页里的运行时开关得驱动 loader，代价是重新 listen、断开当前连接。
- **上游升级可能改变假设** —— 本包依赖 `webserver` / `connection` 这两个行 id，以及 `/api` fence 的行为。`dsh-web-lan` 挂载时会检查实际 bind，被后续 patch 层覆盖时会打 warn 而不是打印不可达的地址。
- **零依赖** —— 只 import `node:os`。`link:` 安装时 Node 按真实路径解析 import，所以没有 `node_modules` 的裸 checkout 也能加载。

## 测试

```powershell
npm test
```
