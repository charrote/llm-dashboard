FROM node:18-alpine

WORKDIR /app

COPY proxy/package*.json ./proxy/
RUN npm ci --only=production --prefix ./proxy

COPY proxy/ ./proxy/
COPY dashboard.html ./
COPY apikey-search.html ./
COPY roocode-guide.html ./
COPY opencode-guide.html ./
COPY openclaw-guide.html ./

RUN mkdir -p /app/proxy/logs && touch /app/proxy/apikeys.json

EXPOSE 9234

CMD ["node", "proxy/server.js"]
