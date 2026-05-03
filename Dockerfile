# 同上：避免 docker.io 经失效镜像加速时报 EOF
FROM public.ecr.aws/docker/library/node:20-alpine AS builder

WORKDIR /app

ENV HUSKY=0

COPY package.json pnpm-lock.yaml ./

RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pnpm && \
    pnpm config set registry https://registry.npmmirror.com && \
    pnpm install --frozen-lockfile

COPY . .

RUN npx prisma generate && pnpm run build

FROM public.ecr.aws/docker/library/node:20-alpine AS runner

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

ENV NODE_ENV=production
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma

EXPOSE 3000

CMD ["node", "dist/main.js"]