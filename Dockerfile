# Runtime image for the resolver. One Node process, no compile step: tsx runs the TypeScript straight
# from src/, the same way `npm start` does. Prompts (src/resolver/*.md) and catalogs (catalogData/) are
# located relative to the source files, so they ship inside the image at the same layout as the repo.
# Deploy runbook: docs/DEPLOY.md. Build with --platform linux/arm64 (Fargate Graviton; native on an ARM Mac).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000

# Dependencies first, so a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY catalogData ./catalogData

USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server/index.ts"]
