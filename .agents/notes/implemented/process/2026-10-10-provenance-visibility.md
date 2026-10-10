# Agent Note: 发布证明按仓库可见性决定

Status: implemented

## Problem

发布工作流无条件给 `npm publish` 加 `--provenance`。`dsh-web-lan` 仓库为私有，registry 在校验 sigstore bundle 时以 E422 拒绝：

```text
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@lolkda%2fdsh-web-lan
npm error Error verifying sigstore provenance bundle: Unsupported GitHub Actions source repository visibility: "private".
npm error Only public source repositories are supported when publishing with provenance.
```

失败发生在 OIDC 换到凭据、tarball 已打好的 PUT 阶段，与代码、测试、真实启动门禁无关。

## Decision

工作流按 `github.event.repository.visibility` 决定是否附带证明：公开时加 `--provenance`，私有时不加并打印一行说明。`id-token: write` 与 npm Trusted Publishing（OIDC）照旧不变 —— 那是取凭据的路径，与是否签证明是两件事。

私有一律不发假证明、也不跳过发布；仓库转公开后无需改代码即自动恢复证明。

## Alternatives considered

- 无条件去掉 `--provenance`：最省事，但仓库公开后会永久丢失供应链证明，且丢失是静默的。
- 把仓库转成公开：能立刻恢复证明，但仓库可见性是维护者的决定，不由发布流水线单方面改变。
- 在私有仓库里伪造或自签证明：registry 明确不接受，且与证明的目的相反。

## Consequences

私有期间 registry 上的版本没有 provenance 记录，仅能通过 OIDC 信任发布与 CI artifact 追溯；转公开后的版本自动带证明。工作流多了一条 env 与一次条件分支，`--tag`、`--access`、`--registry`、dist-tag 闸门与轮询验证都不变。发布日志会显式写出本次是否带证明，便于事后核对。
