FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --production
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
