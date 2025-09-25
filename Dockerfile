# syntax=docker/dockerfile:1

FROM node:20-slim AS build

WORKDIR /app

COPY package.json tsconfig.json ./

RUN npm install

COPY src ./src

RUN npm run build

FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN npm prune --omit=dev \
    && mkdir -p data

VOLUME ["/app/data"]

CMD ["node", "dist/bot.js"]
