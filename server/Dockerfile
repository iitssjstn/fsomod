FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    DOWNLOADS_DIR=/app/downloads

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
 && node -e "require('express'); require('ws')"

COPY src ./src
COPY public ./public
# De workflow zet hier de mod-zip en de .exe neer voordat de image gebouwd wordt.
COPY downloads ./downloads

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/server.js"]
