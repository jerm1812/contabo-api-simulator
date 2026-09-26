# The simulator API itself. Machines it creates come from docker/ubuntu-systemd
# (build that image on the same Docker host; see deploy/staging/up.sh).
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=5550
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
EXPOSE 5550
CMD ["node", "dist/index.js"]
