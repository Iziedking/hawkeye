# syntax=docker/dockerfile:1
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
