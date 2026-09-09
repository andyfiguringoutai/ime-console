# Small, single-process container. SQLite lives on a mounted volume so data
# survives redeploys.
FROM node:20-slim

# build-essential + python3 let better-sqlite3 compile from source if a prebuilt
# binary isn't available for the image; harmless when one is.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# The client bundle (public/app.js) is committed to the repo already-built, so
# there is NO build step here — nothing that can fail during deploy.
COPY . .

# Railway provides persistent storage via its dashboard, mounted at /app/data.
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# On boot: apply migrations, then start.
CMD ["sh", "-c", "node db/migrate.mjs && node src/server.mjs"]
