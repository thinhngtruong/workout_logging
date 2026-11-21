FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY config ./config
USER node
EXPOSE 3000
# migrations + catalog seed run before the API starts; both are safe to repeat
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/main.js"]
