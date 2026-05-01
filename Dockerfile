# 使用 Node.js 24.7.0 slim 版本（轻量级基础镜像）
FROM node:24.7.0-slim

# 安装 Chrome 最新稳定版及必要依赖
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    --no-install-recommends && \
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && \
    apt-get install -y google-chrome-stable --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# 设置时区
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 中文字体
RUN apt-get update && apt-get install -y fonts-wqy-zenhei --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 跳过 Puppeteer 内置 Chromium 下载（使用系统已安装的 Chrome）
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
RUN npm install --production && npm cache clean --force

# 复制项目文件
COPY scripts/cookie_wangxh03.json \
     scripts/cookie_wangxh04.json \
     scripts/cookie_17752768679.json \
     ./puppeteer_user_data/

RUN mkdir -p /app/cookie_defaults && \
    cp /app/puppeteer_user_data/cookie_*.json /app/cookie_defaults/

COPY scripts/clean-browser-profiles.js \
     scripts/quick-plan-update.js \
     ./scripts/

CMD ["node", "scripts/quick-plan-update.js"]