FROM node:24-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api

RUN npm run build --workspace @maxim/contracts && npm run build --workspace @maxim/api

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=base /app/apps/api/dist ./apps/api/dist
COPY --from=base /app/apps/api/package.json ./apps/api/package.json
COPY --from=base /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=base /app/apps/api/prisma ./apps/api/prisma
COPY --from=base /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=base /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=base /app/packages/contracts/package.json ./packages/contracts/package.json

EXPOSE 3001
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
