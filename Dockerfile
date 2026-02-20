# 1. 固定 Node 版本
FROM node:24.7.0-slim

# 2. 安装 Chrome 所需的系统依赖（必须保留）
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
    # 添加 Chrome 稳定版仓库并安装指定版本的 Chrome
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list && \
    apt-get update && \
    # 安装指定版本的 Chrome（此处以 145.0.7632.26 为例，实际可用版本号需查询仓库）
    apt-get install -y google-chrome-stable=145.0.7632.26-1 --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 3. 设置时区
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 4. 安装中文字体（可选，防止页面乱码）
RUN apt-get update && apt-get install -y fonts-wqy-zenhei --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 5. 复制 package.json 并安装依赖（puppeteer 版本已在 package.json 中锁定）
COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "scripts/update-pdd.js"]