# Puppeteer needs a real Chromium + system libraries, so we use a Docker image
# rather than a plain Node buildpack. Works on Railway and Render.
FROM node:20-slim

# System libraries Chromium needs to run headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). The postinstall step downloads
# Chromium into ./.cache/puppeteer via .puppeteerrc.cjs.
COPY package.json .puppeteerrc.cjs ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# PORT is provided by the platform; the server falls back to 3000 locally.
EXPOSE 3000
CMD ["npm", "start"]
