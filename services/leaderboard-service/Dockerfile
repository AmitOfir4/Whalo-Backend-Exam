FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY services/leaderboard-service/package.json ./services/leaderboard-service/

RUN npm ci --workspace=shared --workspace=services/leaderboard-service

COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/leaderboard-service/ ./services/leaderboard-service/

RUN npm run build --workspace=shared
RUN npm run build --workspace=services/leaderboard-service

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/
COPY --from=builder --chown=node:node /app/shared/dist/ ./shared/dist/
COPY --from=builder --chown=node:node /app/services/leaderboard-service/package.json ./services/leaderboard-service/
COPY --from=builder --chown=node:node /app/services/leaderboard-service/dist/ ./services/leaderboard-service/dist/
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/

USER node

WORKDIR /app/services/leaderboard-service

EXPOSE 3003

CMD ["node", "--inspect=0.0.0.0:9231", "dist/app.js"]
