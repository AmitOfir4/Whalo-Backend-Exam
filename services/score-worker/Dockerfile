FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY services/score-worker/package.json ./services/score-worker/

RUN npm ci --workspace=shared --workspace=services/score-worker

COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/score-worker/ ./services/score-worker/

RUN npm run build --workspace=shared
RUN npm run build --workspace=services/score-worker

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/
COPY --from=builder --chown=node:node /app/shared/dist/ ./shared/dist/
COPY --from=builder --chown=node:node /app/services/score-worker/package.json ./services/score-worker/
COPY --from=builder --chown=node:node /app/services/score-worker/dist/ ./services/score-worker/dist/
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/

USER node

WORKDIR /app/services/score-worker

CMD ["node", "dist/worker.js"]
