# The hosted MCP server (mcp/http.js), built from the repository root:
#
#   docker build -f mcp/Dockerfile .
#
# It runs the app's own modules (js/), loaded the way the tests load them
# (test/helpers/load.js), so those come along; nothing else of the site
# does. Two runtime dependencies, installed from the lockfile.
FROM node:22.20.0-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY js ./js
COPY mcp ./mcp
COPY test/helpers/load.js ./test/helpers/load.js

USER node
EXPOSE 3100
CMD ["node", "mcp/http.js"]
