FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build
RUN BASE_PATH=/ PORT=5173 NODE_ENV=production pnpm --filter @workspace/schedule run build

ENV NODE_ENV=production
ENV PORT=8080
ENV WEB_PUBLIC_DIR=/app/artifacts/schedule/dist/public
ENV MIGRATIONS_DIR=/app/lib/db/migrations
ENV SCHEDULE_TEMPLATES_DIR=/app/artifacts/api-server/templates

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
