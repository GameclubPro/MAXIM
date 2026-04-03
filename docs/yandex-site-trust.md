# Yandex Site Trust Checklist

This project can harden the public edge in-repo, but some trust and reputation steps must be done in Yandex Cloud and Yandex services manually.

## In Repo

- Keep the public nginx config in `infra/nginx/maxim.play-team.ru.conf` applied to production.
- Enforce HTTPS only, HSTS, and modern TLS on the public domain.
- Keep only `80` and `443` exposed publicly.

## In Yandex Cloud

1. Reserve a static public IPv4 address for production and attach it to the VM.
2. Enable DDoS protection on the reserved public IP.
3. Keep the DNS `A` record for `maxim.play-team.ru` pinned to the reserved address.
4. If IPv6 compatibility becomes mandatory for some mobile networks, add a dual-stack edge in front of the VM. Yandex Cloud VPC does not currently give this project native public IPv6.

## In Yandex Webmaster

1. Add `https://maxim.play-team.ru/` and verify site ownership.
2. Watch the security and violations section.
3. If Yandex flags the site, fix the reported issue and request a recheck.

## Optional

- If the project needs stronger edge protection, connect Yandex Smart Web Security in front of the domain.
