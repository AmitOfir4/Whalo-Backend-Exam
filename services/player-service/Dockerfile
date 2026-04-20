FROM node:22-alpine AS builder

WORKDIR /app

# Copy root package files and workspace configs
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY services/player-service/package.json ./services/player-service/

# Install all dependencies
RUN npm ci --workspace=shared --workspace=services/player-service

# Copy source
COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/player-service/ ./services/player-service/

# Build shared first, then service
RUN npm run build --workspace=shared
RUN npm run build --workspace=services/player-service

# Production stage
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/
COPY --from=builder --chown=node:node /app/shared/dist/ ./shared/dist/
COPY --from=builder --chown=node:node /app/services/player-service/package.json ./services/player-service/
COPY --from=builder --chown=node:node /app/services/player-service/dist/ ./services/player-service/dist/
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/

USER node

WORKDIR /app/services/player-service

EXPOSE 3001

CMD ["node", "--inspect=0.0.0.0:9234", "dist/app.js"]
