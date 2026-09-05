FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY . .
RUN pnpm install --frozen-lockfile
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused pnpm db:generate && pnpm build

FROM build AS runtime
ENV NODE_ENV=development
USER node
EXPOSE 3000 3001
CMD ["node", "apps/backend/dist/src/main.js"]
