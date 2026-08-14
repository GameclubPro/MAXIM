# syntax=docker/dockerfile:1.7

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS manifests
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/miniapp/package.json apps/miniapp/package.json
COPY packages/contracts/package.json packages/contracts/package.json

FROM manifests AS prod-deps
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm pkg delete scripts.prepare \
  && npm ci --omit=dev --workspace @maxim/api --workspace @maxim/contracts

FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  HUSKY=0 npm ci \
    --workspace @maxim/api \
    --workspace @maxim/contracts \
    --include-workspace-root

COPY tsconfig.base.json ./
COPY scripts scripts
COPY packages/contracts packages/contracts
COPY apps/api apps/api

RUN npm run build --workspace @maxim/contracts && npm run build --workspace @maxim/api

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/home/node
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt

COPY infra/certs/russian-trusted-root-ca.pem /usr/local/share/ca-certificates/russian-trusted-root-ca.crt
COPY infra/certs/russian-trusted-sub-ca.pem /usr/local/share/ca-certificates/russian-trusted-sub-ca.crt
RUN apk add --no-cache \
    ca-certificates \
    font-dejavu=2.37-r6 \
    tesseract-ocr=5.5.2-r0 \
    tesseract-ocr-data-eng=5.5.2-r0 \
    tesseract-ocr-data-rus=5.5.2-r0 \
  && cat /usr/local/share/ca-certificates/russian-trusted-root-ca.crt \
    > /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt \
  && printf '\n' >> /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt \
  && cat /usr/local/share/ca-certificates/russian-trusted-sub-ca.crt \
    >> /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt \
  && chmod 0644 /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt \
  && update-ca-certificates

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=prod-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json

RUN node apps/api/dist/apps/api/src/scripts/commercial-ocr-native-build-manifest.js \
    --output /app/apps/api/commercial-ocr-native-build-manifest.json \
  && chown root:root /app/apps/api/commercial-ocr-native-build-manifest.json \
  && chmod 0444 /app/apps/api/commercial-ocr-native-build-manifest.json

EXPOSE 3001
USER node
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
