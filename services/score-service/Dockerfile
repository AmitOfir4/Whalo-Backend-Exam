FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY services/score-service/package.json ./services/score-service/

RUN npm ci --workspace=shared --workspace=services/score-service

COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/score-service/ ./services/score-service/

RUN npm run build --workspace=shared
RUN npm run build --workspace=services/score-service

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/
COPY --from=builder --chown=node:node /app/shared/dist/ ./shared/dist/
COPY --from=builder --chown=node:node /app/services/score-service/package.json ./services/score-service/
COPY --from=builder --chown=node:node /app/services/score-service/dist/ ./services/score-service/dist/
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/

USER node

WORKDIR /app/services/score-service

EXPOSE 3002

CMD ["node", "--inspect=0.0.0.0:9230", "dist/app.js"]
