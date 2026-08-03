# King AI Operations Hub — production image (O-21).
# One image runs BOTH roles; the compose/fly process picks the command:
#   web:    node server.js         (Next standalone server)
#   worker: npm run worker         (durable run worker)
#   migrate:npm run db:migrate     (release/one-off task)

# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# A build-time DB is not required; Next builds without touching Postgres.
RUN npm run build

# G-Backup-B2a — bake the exact source identity into an IMMUTABLE file so the release-machine pre-migration gate
# can verify it against the signed receipt WITHOUT a runtime build-arg and WITHOUT .git. The controller/CI passes
# these build args (git-derived); when absent they default to UNKNOWN, which the gate treats as fatal on staging.
ARG SOURCE_COMMIT=UNKNOWN
ARG PORTABLE_MIGRATION_SET_HASH=UNKNOWN
RUN printf '{"sourceCommit":"%s","portableMigrationSetHash":"%s"}\n' "$SOURCE_COMMIT" "$PORTABLE_MIGRATION_SET_HASH" > /app/source-identity.json

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Non-root.
RUN groupadd -r app && useradd -r -g app app

# Next standalone output + static assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# The worker and migrate commands need tsx + source + drizzle + full deps.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
# G-Backup-B2a — the baked immutable source identity MUST be present in the RUNTIME image (the migrate command runs
# here), at the exact path scripts/migrate.ts reads: <cwd=/app>/source-identity.json.
COPY --from=build /app/source-identity.json ./source-identity.json

USER app
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# Default command is the web server; override for worker/migrate.
CMD ["node", "server.js"]
