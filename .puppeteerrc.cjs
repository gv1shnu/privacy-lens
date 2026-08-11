const { join } = require("node:path");

/**
 * Keep the downloaded Chromium inside the project so it survives
 * Railway / Render builds (their default cache dir is wiped between build & run).
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
