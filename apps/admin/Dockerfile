FROM node:24-alpine AS build
WORKDIR /app

ARG ADMIN_BASE_PATH=/
ARG VITE_PUBLIC_BASE_PATH=/
ARG VITE_ADMIN_ACCESS_CODE

ENV ADMIN_BASE_PATH=${ADMIN_BASE_PATH}
ENV VITE_PUBLIC_BASE_PATH=${VITE_PUBLIC_BASE_PATH}
ENV VITE_ADMIN_ACCESS_CODE=${VITE_ADMIN_ACCESS_CODE}

COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/miniapp/package.json apps/miniapp/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/admin apps/admin

RUN test -n "$VITE_ADMIN_ACCESS_CODE" && test "$VITE_ADMIN_ACCESS_CODE" != "change-me"
RUN npm run build --workspace @maxim/admin

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
