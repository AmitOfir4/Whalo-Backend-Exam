FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY services/log-worker/package.json ./services/log-worker/

RUN npm ci --workspace=shared --workspace=services/log-worker

COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/log-worker/ ./services/log-worker/

RUN npm run build --workspace=shared
RUN npm run build --workspace=services/log-worker

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/
COPY --from=builder --chown=node:node /app/shared/dist/ ./shared/dist/
COPY --from=builder --chown=node:node /app/services/log-worker/package.json ./services/log-worker/
COPY --from=builder --chown=node:node /app/services/log-worker/dist/ ./services/log-worker/dist/
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/

USER node

WORKDIR /app/services/log-worker

CMD ["node", "dist/worker.js"]
