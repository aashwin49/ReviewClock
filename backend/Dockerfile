FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server/worker.js server/streamHub.js ./server/
COPY --chown=node:node server/models/ ./server/models/
COPY --chown=node:node server/logic/ ./server/logic/

USER node

CMD ["node", "server/worker.js", "--once"]
