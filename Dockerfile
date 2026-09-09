FROM node:18-slim

# Устанавливаем ffmpeg и python3 (необходим для работы yt-dlp)
RUN apt-get update && apt-get install -y ffmpeg python3 curl && rm -rf /var/lib/apt/lists/*

# Скачиваем саму утилиту yt-dlp в системную папку bin
RUN curl -L https://github.com -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
# Хостинг сам установит JS-зависимости здесь
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
