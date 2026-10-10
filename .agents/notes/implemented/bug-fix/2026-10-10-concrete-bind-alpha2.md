# Agent Note: 新版 DSH 的具体网卡监听与信任配置

Status: implemented

## Problem

DSH 0.2.1-alpha.2 拒绝 0.0.0.0/:: 的 wildcard bind，现有 bundle 因此在 webserver 启动前失败。新版 connection 从 webStartup 获取 trustedHosts，旧 webRuntime.trustedHosts 已不存在。插件运行期也将具体地址误判成非 LAN 并关闭远程设置。

## Decision

插件提供独立、零第三方运行期依赖的监听配置服务，在 webserver 创建前解析地址。优先级为 CLI --host > DSH_WEB_LOOPBACK=1 > DSH_WEB_HOST > 自动选择第一个非 internal IPv4；没有可用 IPv4 时使用 loopback 并明确提示。显式地址必须是本机具体 IP，拒绝 wildcard 和非本机地址，不模糊回退。仅监听单一接口，不再承诺全部网卡同时可访问；多网卡部署使用显式地址。

connection 保留 webStartup.trustedHosts 和 DSH_WEB_TRUSTED_HOSTS，监听 IP 由新版原生 fence 接纳，不自动扩大到全部接口。运行期只打印实际监听地址，具体非 loopback bind 启用远程设置，loopback 禁用。保留 autoLogin、bootstrap 路由拒绝不可信 Host、cookie 配置和客户端设置行为，不修改 DSH 源码或运行中的 GUI。

新版插件采用 0.4.0，发布仍通过现有 tag/OIDC 流程。针对当前新版宿主做真实 Web 启动、/go/token-cookie、index flag、API fence 验证；旧宿主的 wildcard-only 限制不通过改包绕过，文档说明升级要求。

## Existing note audit

该仓库没有 .agents/notes 或其他决策目录，故无重叠活跃笔记。README 的全部接口与 webRuntime trust 说明需要同步替换，不保留已过时的能力承诺。

## Alternatives considered

- 继续 wildcard：多网卡都能访问且无需选地址，是旧插件的主要便利，但新版明确拒绝，不能在配置层修复，且用户已选择具体网卡方案。
- 固定 loopback：实现最小、单机启动可靠，但丢失 LAN 和 bridge 端口映射访问，不符合保留远程访问的目标。
- 修改宿主地址校验：能保留旧行为，但引入第二个宿主补丁，违背本次使用公开插件配置适配的边界。

## Testing

- 单元测试验证 CLI/loopback/env/自动选择优先级、本机字面量与非法值拒绝、无 IPv4 fallback、真实 YAML/include/Loader 组合求值。测试依赖补充 include 和 js-yaml，不增加运行期依赖。
- 运行期测试覆盖具体 IP flag、IPv6 URL、TLS 实际协议、loopback、bootstrap Host 拒绝及路由释放。旧宿主 wildcard 分支仅为旧监听形态保留，不使新版绕过限制。
- 真实隔离启动验证当前 tarball 在 DSH0.2.1-alpha.2 中的安装与激活、/go→token→cookie、index flag、已认证 API 以及未认证401/未信任403；不运行付费模型，不修改用户 profile。可复现入口为 `npm run test:runtime`（执行 `scripts/test-runtime.mjs`）。
- 首页客户端入口和资源可用性不等于新版浏览器设置完整现场验收；客户端组件单元仍以锁定旧SDK验证生命周期。CI发布前增加宿主真实启动门禁，并显式安装 DSH plugin manager 所需的 pnpm。

## Consequences

新版启动恢复并保留 LAN、登录和远程设置 opt-in；单具体接口明确缩小监听范围，TLS URL 使用原生 protocol getter。自动选择顺序可能优先 VPN，需要显式配置并查看输出。旧 DSH 不一定接受具体 LAN IP，无限制元数据不等于行为向后兼容，文档不承诺旧宿主兼容。Bridge 浏览器 authority 通常为宿主IP，需要明确 trustedHosts，不通过信任所有接口修复。正式发布仍使用原 OIDC/tag 流程，registry与镜像验收结果单独核对，不将本地绿灯当发布成功。
