# 每周小结助手 WEEKLY·OS - 云端部署镜像
# 安全设计：镜像内【不包含】API Key。
# 密钥通过部署平台的环境变量 AI_API_KEY 注入（lib/config.js 支持环境变量覆盖），
# 这样镜像可公开推送到 Docker Hub / GHCR，不会泄露 DeepSeek Key。

FROM node:20-slim

WORKDIR /app

# 先装依赖（利用构建缓存）
COPY package.json ./
RUN npm install --omit=dev

# 拷贝源码
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 使用【无密钥】配置作为默认配置（部署时用 AI_API_KEY 环境变量注入 Key）
COPY config.docker.json ./config.json

# 数据目录（云平台请挂载持久卷到此，避免容器重建丢数据）
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
