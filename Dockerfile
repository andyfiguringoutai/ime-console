# Small, single-process container. SQLite lives on a mounted volume so data
# survives redeploys.
FROM node:20-slim

WORKDIR /app

# Build tools only for the install step, then dropped — better-sqlite3 has a
# prebuilt binary for this platform, so this is belt-and-suspenders.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .
RUN npm run build   # bundle the client into public/app.js

# data/ (the SQLite db + uploaded documents) is a volume, not baked in
VOLUME /app/data
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# On boot: apply migrations, then start. Seeding/admin creation is manual (below).
CMD ["sh", "-c", "node db/migrate.mjs && node src/server.mjs"]
