FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DENO_INSTALL=/root/.deno \
    PATH="/root/.deno/bin:${PATH}" \
    npm_config_python=/usr/bin/python3

# Build tools are required if @discordjs/opus cannot download a matching prebuilt binary.
# libopus-dev provides the headers/libraries for the fallback native build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl unzip ffmpeg \
       python3 make g++ pkg-config libopus-dev \
    && rm -rf /var/lib/apt/lists/*

# Official standalone yt-dlp binary (includes the yt-dlp EJS scripts).
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
    && chmod a+x /usr/local/bin/yt-dlp

# Deno is used by yt-dlp for modern YouTube JavaScript challenges.
RUN curl -fsSL https://deno.land/install.sh | sh

WORKDIR /app
COPY package*.json ./

# Show native install-script output in Render build logs and retry transient registry errors.
RUN npm install --omit=dev --no-audit --no-fund --foreground-scripts \
      --fetch-retries=5 --fetch-timeout=600000 \
    && node -e "require('discord.js'); require('@discordjs/voice'); require('@discordjs/opus'); require('@snazzah/davey'); console.log('Node dependencies loaded successfully')"

COPY . .

CMD ["node", "index.js"]
