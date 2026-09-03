FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --prefer-offline
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --prefer-offline
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
EXPOSE 4173
CMD ["node", "server-dist/index.js"]
