FROM node:18-slim

RUN apt-get update && apt-get install -y ffmpeg python3 curl && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# ПРИНУДИТЕЛЬНО ОБНОВЛЯЕМ YT-DLP ДО САМОЙ СВЕЖЕЙ ВЕРСИИ
RUN yt-dlp -U

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
