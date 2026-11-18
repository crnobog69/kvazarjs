FROM oven/bun:alpine

# yt-dlp uses Node.js and the bundled EJS scripts to resolve YouTube streams.
RUN apk add --no-cache \
    ffmpeg \
    nodejs \
    python3 \
    py3-pip \
    && pip3 install --no-cache-dir --break-system-packages 'yt-dlp[default]'

WORKDIR /app

# Copy package manifests and install dependencies
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Copy source code
COPY src ./src

# Run as non-root
USER bun

CMD ["bun", "run", "src/index.ts"]
