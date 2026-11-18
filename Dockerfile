FROM oven/bun:alpine

# Install runtime dependencies (ffmpeg and yt-dlp)
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

# Copy package manifests and install dependencies
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Copy source code
COPY src ./src

# Run as non-root
USER bun

CMD ["bun", "run", "src/index.ts"]
