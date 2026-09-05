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
COPY scripts/*.mjs ./scripts/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
EXPOSE 4173
CMD ["node", "server-dist/index.js"]

FROM runtime AS hosted
COPY --from=bluenviron/mediamtx:1.12.2 /mediamtx /usr/local/bin/mediamtx
COPY media-relay/mediamtx.yml /app/media-relay/mediamtx.yml
RUN mkdir -p /home/node/.ssh && chmod 0700 /home/node/.ssh && chown node:node /home/node/.ssh
USER node
EXPOSE 4174
CMD ["node", "scripts/hosted.mjs"]
