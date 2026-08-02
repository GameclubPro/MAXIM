# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS build
WORKDIR /app

ARG MINIAPP_BASE_PATH=/app/
ARG VITE_PUBLIC_BASE_PATH=/app/
ARG VITE_API_BASE=/api/v1
ARG VITE_API_FALLBACK_BASES=
ARG VITE_ROUTER_MODE=browser
ARG VITE_APP_NAME="Майор Максимов"
ARG VITE_APP_DESCRIPTION="Мини-приложение для управления чатами, каналами и настройками бота в MAX."
ARG VITE_APP_CANONICAL_URL=https://major-maksimov.ru/app/

ENV MINIAPP_BASE_PATH=${MINIAPP_BASE_PATH}
ENV VITE_PUBLIC_BASE_PATH=${VITE_PUBLIC_BASE_PATH}
ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_API_FALLBACK_BASES=${VITE_API_FALLBACK_BASES}
ENV VITE_ROUTER_MODE=${VITE_ROUTER_MODE}
ENV VITE_APP_NAME=${VITE_APP_NAME}
ENV VITE_APP_DESCRIPTION=${VITE_APP_DESCRIPTION}
ENV VITE_APP_CANONICAL_URL=${VITE_APP_CANONICAL_URL}

COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/miniapp/package.json apps/miniapp/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  HUSKY=0 npm ci \
    --workspace @maxim/miniapp \
    --workspace @maxim/contracts \
    --include-workspace-root

COPY tsconfig.base.json ./
COPY scripts scripts
COPY apps/api/jest.config.cjs apps/api/jest.config.cjs
COPY bot.webp frendly.webp joker.webp police.webp ./
COPY packages/contracts packages/contracts
COPY apps/miniapp apps/miniapp

RUN npm run build --workspace @maxim/contracts && npm run build --workspace @maxim/miniapp \
  && sed -i \
    -e "s|Майор Максимов: мини-приложение для управления чатами, каналами и настройками бота в MAX.|${VITE_APP_DESCRIPTION}|g" \
    -e "s|Мини-приложение для управления чатами, каналами и настройками бота в MAX.|${VITE_APP_DESCRIPTION}|g" \
    -e "s|https://major-maksimov.ru/app/|${VITE_APP_CANONICAL_URL}|g" \
    -e "s|/app/favicon.png|${VITE_PUBLIC_BASE_PATH}favicon.png|g" \
    -e "s|/app/apple-touch-icon.png|${VITE_PUBLIC_BASE_PATH}apple-touch-icon.png|g" \
    -e "s|/app/site.webmanifest|${VITE_PUBLIC_BASE_PATH}site.webmanifest|g" \
    -e "s|content=\"Майор Максимов\"|content=\"${VITE_APP_NAME}\"|g" \
    -e "s|>Майор Максимов<|>${VITE_APP_NAME}<|g" \
    apps/miniapp/dist/index.html \
  && sed -i \
    -e "s|\"name\": \".*\"|\"name\": \"${VITE_APP_NAME}\"|g" \
    -e "s|\"short_name\": \".*\"|\"short_name\": \"${VITE_APP_NAME}\"|g" \
    -e "s|\"start_url\": \".*\"|\"start_url\": \"${VITE_PUBLIC_BASE_PATH}\"|g" \
    -e "s|\"scope\": \".*\"|\"scope\": \"${VITE_PUBLIC_BASE_PATH}\"|g" \
    -e "s|\"src\": \"/app/|\"src\": \"${VITE_PUBLIC_BASE_PATH}|g" \
    apps/miniapp/dist/site.webmanifest

FROM nginx:1.27-alpine AS runtime
ARG MINIAPP_BASE_PATH=/app/
COPY --from=build /app/apps/miniapp/dist /tmp/miniapp-dist
COPY apps/miniapp/nginx.conf.template /tmp/default.conf.template
RUN mkdir -p "/usr/share/nginx/html${MINIAPP_BASE_PATH}" \
  && cp -R /tmp/miniapp-dist/. "/usr/share/nginx/html${MINIAPP_BASE_PATH}" \
  && sed "s|__MINIAPP_BASE_PATH__|${MINIAPP_BASE_PATH}|g" /tmp/default.conf.template > /etc/nginx/conf.d/default.conf \
  && rm -rf /tmp/miniapp-dist /tmp/default.conf.template
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
