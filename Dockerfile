FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
EXPOSE 3000
# Run DB migration first (safe to re-run — all statements use IF NOT EXISTS),
# then start the server.
CMD ["sh", "-c", "node scripts/setup_db.js && node server.js"]
