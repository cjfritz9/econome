FROM node:22-alpine
# Pin pnpm to package.json's packageManager: an unpinned corepack fetches the newest pnpm, which once broke Mise's build.
ENV PNPM_VERSION=10.28.2 NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/http/main.ts"]
