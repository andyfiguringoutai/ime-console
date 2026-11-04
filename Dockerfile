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

# Railway provides persistent storage via its dashboard. The volume MUST be
# mounted at /app/storage — that is where the SQLite database and uploaded
# documents are written. (The read-only gazetteer in /app/data is baked into
# the image; do NOT mount the volume over /app/data or it hides those files.)
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# On boot: apply migrations, then start.
CMD ["node", "src/server.mjs"]
