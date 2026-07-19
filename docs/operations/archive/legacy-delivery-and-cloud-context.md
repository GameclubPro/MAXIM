# Archived Delivery And Cloud Context

> **Non-authoritative historical record.** This file is not an active runbook and must not be used
> to choose deploy targets, smoke URLs, fallback hosts, DNS changes, or cloud operations. Verify the
> current repository, root/scoped `AGENTS.md`, and `docs/runbook.md` instead.

Current routine production mini app delivery uses only `https://major-maksimov.ru/app/` through
`miniapp-major-static`. CDN, Object Storage, app2, and the VK Cloud proxy are dormant.

## Retired app2/CDN shell

- `app2.major-maksimov.ru/app/` previously served a restricted-LTE shell through Yandex CDN and
  Object Storage. It is not a current deploy or smoke target.
- The retired shell used `VITE_PUBLIC_BASE_PATH=/app/`, hash routing, `api-cdn.flex-craft.ru`, and
  objects below `s3://flex-craft-canary-20260608/app/`.
- The CDN API front door accepted GET/HEAD/OPTIONS only. Writes were tunneled through the historical
  GET mutation path implemented by `apps/api/src/system/miniapp-mutation-tunnel.controller.ts` and
  `apps/miniapp/src/lib/api/transport-mutation-tunnel.ts`.
- The retired shell sent `Authorization: InitData <initData>` and required CORS allowance for
  `authorization, content-type`.
- These compatibility modules can still exist in source, but their presence does not authorize a
  CDN publish, Object Storage upload, app2 smoke, or fallback plan.

## Restricted mobile-network observations

- Historical tests found that the Yandex edge could work from Wi-Fi/Megafon while failing before
  HTML/TLS/application logic on some MTS/Beeline paths. These were time- and operator-specific
  observations, not an application routing invariant.
- The production Major domains historically entered via Yandex edge public IP `84.201.186.244`;
  never use this archived address instead of current DNS/cloud inventory.
- The corresponding backend private address was recorded as `10.130.0.29`; it is historical
  inventory, not a value to copy into current HAProxy or firewall configuration.
- A VK Cloud proxy was evaluated only as a reachability test. Public DNS was not meant to move to a
  VK `185.241.*` address without testing that exact address on affected networks.

## Dormant VK Cloud proxy experiment

- The test proxy forwarded `/app/` and `/api/` to the Yandex origin. Repo artifacts remain under
  `infra/vk-proxy/`, `infra/www/major-maksimov/`, and `infra/scripts/vk-apply-major-proxy.sh`.
- Historical checks used `curl --resolve major-maksimov.ru:443:<vk-ip>` instead of public DNS.
- A former SSH fallback used `maxim-vk-jump` at `ubuntu@94.139.246.178`, local key path
  `~/.ssh/id_rsa_vk_maxim_proxy`, and `ProxyJump` aliases for backend/edge access. Treat all of these
  values as stale until independently verified.
- The service-account file was locally named `vk codex`. Private key or credential content must
  never be printed or committed.
- From one local network, `https://public.infra.mail.ru` endpoints were more reachable than catalog
  `infra.mail.ru` endpoints. This was an observation, not a permanent provider rule.
- The test project allowed direct `internet` ports but rejected explicit `fixed_ips` requests on the
  shared network; a desired `217.16.28.0/22` allocation required provider support.
- VM rebuild experiments required OpenStack config drive for SSH/network injection. Image boot could
  fail with `BadRequest`; boot-from-volume using `block_device_mapping_v2` and
  `delete_on_termination=true` was the successful historical pattern.

## Why this context is archived

- Operator reachability changes independently of code, DNS, certificates, and cloud allocation.
- Old IPs, bucket names, proxy routes, and service-account capabilities drift quickly.
- Reintroducing any retired path is a new infrastructure project requiring explicit user approval,
  current network tests, security review, deployment design, and new active documentation.
