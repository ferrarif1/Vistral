ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
ARG NGINX_BASE_IMAGE=docker.m.daocloud.io/library/nginx:1.27-alpine

FROM ${NODE_BASE_IMAGE} AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.html ./
COPY src ./src
COPY shared ./shared
COPY tsconfig*.json ./
COPY vite.config.* ./
RUN npm run build

FROM ${NGINX_BASE_IMAGE} AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
