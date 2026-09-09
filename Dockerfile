FROM node:18-slim

# Устанавливаем нужные системные пакеты
RUN apt-get update && apt-get install -y ffmpeg python3 curl && rm -rf /var/lib/apt/lists/*

# Скачиваем стабильный бинарный файл yt-dlp для Linux
RUN curl -L https://github.com -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
