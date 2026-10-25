# syntax=docker/dockerfile:1.7
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/eraser/package.json apps/eraser/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked HUSKY=0 npm ci --workspace @maxim/eraser --include-workspace-root
COPY apps/eraser apps/eraser
RUN npm run build --workspace @maxim/eraser

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/eraser/package.json apps/eraser/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm pkg delete scripts.prepare && npm ci --omit=dev --workspace @maxim/eraser && mkdir -p apps/eraser/node_modules

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt
COPY infra/certs/russian-trusted-root-ca.pem /usr/local/share/ca-certificates/russian-trusted-root-ca.crt
COPY infra/certs/russian-trusted-sub-ca.pem /usr/local/share/ca-certificates/russian-trusted-sub-ca.crt
RUN cat /usr/local/share/ca-certificates/russian-trusted-root-ca.crt > /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt \
  && printf '\n' >> /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt \
  && cat /usr/local/share/ca-certificates/russian-trusted-sub-ca.crt >> /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt \
  && chmod 0644 /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/eraser/node_modules ./apps/eraser/node_modules
COPY --from=build /app/apps/eraser/dist ./apps/eraser/dist
COPY --from=build /app/apps/eraser/migrations ./apps/eraser/migrations
COPY --from=build /app/apps/eraser/package.json ./apps/eraser/package.json
ARG COMMIT_SHA=development
ENV COMMIT_SHA=$COMMIT_SHA
LABEL com.maxim.release-protected="true" com.maxim.component="eraser" org.opencontainers.image.revision=$COMMIT_SHA
USER node
EXPOSE 3000
CMD ["node", "apps/eraser/dist/main.js"]
