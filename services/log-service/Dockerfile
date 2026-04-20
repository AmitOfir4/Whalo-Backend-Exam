FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY services/log-service/package.json ./services/log-service/

RUN npm ci --workspace=shared --workspace=services/log-service

COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/log-service/ ./services/log-service/

RUN npm run build --workspace=shared
RUN npm run build --workspace=services/log-service

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/
COPY --from=builder --chown=node:node /app/shared/dist/ ./shared/dist/
COPY --from=builder --chown=node:node /app/services/log-service/package.json ./services/log-service/
COPY --from=builder --chown=node:node /app/services/log-service/dist/ ./services/log-service/dist/
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/

USER node

WORKDIR /app/services/log-service

EXPOSE 3004

CMD ["node", "dist/app.js"]
