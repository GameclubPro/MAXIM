FROM node:20-alpine AS build
WORKDIR /app

COPY package.json ./
COPY apps/miniapp/package.json apps/miniapp/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm install

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/miniapp apps/miniapp

RUN npm run build --workspace @maxim/contracts && npm run build --workspace @maxim/miniapp

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/miniapp/dist /usr/share/nginx/html/app
COPY apps/miniapp/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
