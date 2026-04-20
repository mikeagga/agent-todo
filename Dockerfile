# syntax=docker/dockerfile:1
FROM node:20-slim

WORKDIR /app

# Install app deps first (better layer caching)
COPY package*.json ./
RUN npm ci

# Install pi CLI globally (bot spawns `pi --mode rpc`)
RUN npm install -g @mariozechner/pi-coding-agent

# Copy app source
COPY . .

# Optional but useful in containerized prod
ENV NODE_ENV=production

# Start: run migrations/init, then run both processes:
# - telegram relay bot (background)
# - dashboard web server (foreground, binds PORT on Railway)
CMD ["sh", "-lc", "npm run start:all"]
