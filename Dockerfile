# Jaga — risk-guardian agent for Binance Agent OS
#   docker build -t jaga .
#   docker run --rm -p 7777:7777 -e JAGA_DASHBOARD_TOKEN=change-me-please-16 jaga            # paper mode, live Binance prices
#   docker run --rm -p 7777:7777 -e JAGA_DASHBOARD_TOKEN=change-me-please-16 jaga npm run demo  # real Aug-2024 crash replay
# Then open http://localhost:7777/?token=change-me-please-16
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs *.json ./
# inside a container the dashboard must bind 0.0.0.0 — so a token is mandatory (config validation enforces it)
RUN node -e "for (const f of ['config.paper.json','config.demo.json']) { const c = JSON.parse(require('fs').readFileSync(f)); c.dashboard.host = '0.0.0.0'; require('fs').writeFileSync(f, JSON.stringify(c, null, 2)); }"
ENV NODE_ENV=production
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:7777/healthz || exit 1
CMD ["npm", "run", "paper"]
