# @lolkda/dsh-web-lan

让 `dsh web` 能被局域网或 VPN（SD-WAN、Tailscale、ZeroTier）中的其他设备访问，通过公开插件配置实现，不修改 DSH 安装文件。

## 安装与版本

```bash
dsh plugin --profile web add @lolkda/dsh-web-lan@0.4.0
dsh web
```

**0.4.0 针对 DSH `0.2.1-alpha.2` 的监听与信任接口适配。** 新版 DSH 接受具体本机 IP，拒绝 `0.0.0.0` / `::`。插件从旧版“所有接口监听”改为“选择一个具体接口监听”，不能再声称每个网卡地址同时可达。

DSH peer 与兼容元数据仍为 `*`，这只允许加载，不保证所有旧版 API 兼容。旧宿主若只接受 loopback/wildcard，应升级宿主；不通过修改宿主校验来支持它。

安装会把 bundle 配置加入 Web profile，之后正常 `dsh web` 即可。安装、卸载或修改绑定配置后需要重启 DSH，再刷新浏览器；更新源码不会热替换已安装的 npm 副本。

## 监听地址选择

按以下顺序决定，前面的设置优先：

1. CLI `--host <具体本机 IP>`。
2. `DSH_WEB_LOOPBACK=1`：使用 `127.0.0.1`。
3. `DSH_WEB_HOST=<具体本机 IP>`。
4. 自动使用 `os.networkInterfaces()` 返回的第一个非 internal IPv4。
5. 没有非 internal IPv4 时，回退 `127.0.0.1` 并提示无法 LAN 访问。

自动选择不会判断默认路由，也不能保证优先物理网卡；多网卡/VPN 部署请显式指定。非法、wildcard、非本机显式地址会失败，不悄悄换地址。显式 IPv6 使用具体本机地址，URL 以方括号表示。

```bash
# 选择固定 LAN/VPN 网卡
DSH_WEB_HOST=192.168.1.5 dsh web
# CLI 更高优先级
dsh web --host 192.168.1.5
# 临时只本机
DSH_WEB_LOOPBACK=1 dsh web
```

PowerShell 对应写法：

```powershell
$env:DSH_WEB_HOST='192.168.1.5'; dsh web
$env:DSH_WEB_LOOPBACK='1'; dsh web
```

默认端口仍为 `3080`，`--port 0` 允许操作系统选择空闲端口。TLS 使用 DSH 原生 `--tls-cert` / `--tls-key`，打印与重定向使用实际协议。

启动只打印真正监听的地址，例如：

```text
dsh-web-lan: listening on 192.168.1.5:3080 within 家用局域网 / 虚拟局域网 / VPN
dsh-web-lan:   http://192.168.1.5:3080/go
```

其他网卡不会因此也监听；要同时服务多个接口请自行配置反向代理，本插件不新建多个 listener。

## 访问与信任

- **监听**：前置 `webLanBind` 服务在 webserver 初始化前选择地址，不在启动后改监听。
- **Host/Origin 围栏**：保留新版 `webStartup.trustedHosts` 的 CLI 值并追加 `DSH_WEB_TRUSTED_HOSTS`。监听 IP 由 DSH 原生围栏接纳；插件不自动信任所有网卡或任意 authority。
- **认证**：默认保留免 token 的 `/go` 入口；不可信 Host 会被拒绝，登录仍使用 DSH 的 token→cookie 流程。
- **会话**：cookie 有效期保持 3650 天，密钥由宿主原有持久化机制管理。

若通过域名、反向代理或 Docker bridge 的宿主地址访问，要明确配置浏览器使用的 authority：

```bash
DSH_WEB_TRUSTED_HOSTS=dev.example,192.168.1.10:3080 dsh web
# 或新版 DSH 的 CLI 参数
dsh web --trusted-host dev.example
```

**Docker bridge**：自动选择的是容器 IP，端口映射到这个接口；浏览器使用宿主 IP/域名，需加入上述信任列表。**host 网络**：显式选择宿主的目标网卡 IP。只监听容器 `127.0.0.1` 不能靠普通 `-p` 映射获得远端访问。

## 插件配置

| 字段 | bundle 默认 | 说明 |
|---|---|---|
| `autoLogin` | `true` | 注册免 token 入口；设为 false 使用每台设备一次 token 登录 |
| `bootstrapPath` | `/go` | exact 路由，优先于 SPA fallback |
| `printLanUrls` | `true` | 打印实际监听地址，不列出其他未监听网卡 |
| `remoteSettings` | `true` | 对具体非 loopback 监听启用远程设置标志；loopback 禁用 |

### 免 token 入口

打开实际监听地址的 `/go`，它通过 `connection.authenticatedUrl(...)` 重定向到 token 登录。默认开启沿用 0.3.0 行为：能连接并通过 Host 围栏的设备即可进入。只在自己选择的可信网络中使用；需要逐设备认证时关闭：

```yaml
- id: dsh-web-lan
  name: '@lolkda/dsh-web-lan'
  config:
    autoLogin: false
```

profile 中 id 定向配置整体替换该行 config，非逐字段合并。只写 autoLogin false 时其他字段回落到插件默认值；要保留其他显式值请一并填写。

### 远程设置

客户端通过公开 Loader/设置 RPC 为已认证的远程浏览器提供宿主设置，不修改全局 `isLoopback`，所有读取和保存仍通过宿主认证、Host/Origin 与写权限检查。设置属于宿主共享配置，并非浏览器私有副本。正常卸载客户端插件恢复原设置服务；安装/卸载整个 npm 包须重启和刷新。

```yaml
- id: dsh-web-lan
  name: '@lolkda/dsh-web-lan'
  config:
    remoteSettings: false
    autoLogin: true
```

原始文档编辑/本机打开仍遵守上游限制；如果手工替换官方基础设置插件，刷新页面重新建立服务关系，不接管用户自定义隔离服务。

## 卸载

```bash
dsh plugin --profile web remove @lolkda/dsh-web-lan
```

重启后恢复原 Web profile 的监听配置。

## 测试

```bash
npm ci --ignore-scripts
npm run check
npm run verify-notes
npm run test:runtime
```

单元回归覆盖地址优先级与本机 IP 校验、真实 YAML/bundle 求值、bootstrap/标志/URL、官方客户端设置组件的生命周期、保存拒绝和卸载恢复。真实启动测试隔离安装 DSH `0.2.1-alpha.2` 与本次打包产物，检查具体 IP、loopback、认证和 Host 围栏；不会启动替代当前 GUI 的服务或改用户 profile。测试服务采用独立临时目录和端口，结束清理。单元客户端组件仍使用锁定旧 SDK，不能代替新版浏览器现场验收。

宿主仅依赖 Node 内置模块，客户端通过宿主模块表加载；运行期零第三方依赖。决策记录在 [.agents/notes](.agents/notes/)。

## 发布

现有 `.github/workflows/publish.yml` 使用 tag/OIDC 发布，测试→版本闸门→打包一次→上传 artifact→发布同一 tarball。CI 增加真实新版启动验收，失败不发布。

```bash
git tag v0.4.0
git push origin v0.4.0
```

版本标签必须匹配 package.json，已发布版本不可覆盖，正式版走 latest、预发布走 next。npm Trusted Publishing 配置继续使用仓库 `lolkda/dsh-web-lan` 的 `publish.yml`，不引入长期 token。发布后验证 registry 版本可读且 dist-tag 指向本次版本，保留原有短暂传播重试。

本地检查产物（不发布）：

```bash
mkdir -p dist
npm pack --pack-destination dist
npm publish ./dist/*.tgz --tag latest --dry-run
```
