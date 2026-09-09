// Инициализируем чтение переменных из файла .env (или настроек хостинга)
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Проверяем обязательную переменную окружения
if (!process.env.BOT_TOKEN) {
  console.error('❌ Ошибка: Переменная BOT_TOKEN не задана в окружении!');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID) || 0; 

// Лимит Telegram на отправку файлов для обычных ботов (50 МБ в байтах)
const TG_FILE_LIMIT = 49 * 1024 * 1024; 

// Временное хранилище для ссылок пользователей
const userSessions = new Map();

// Файл для хранения статистики
const STATS_FILE = path.join(__dirname, 'stats.json');
if (!fs.existsSync(STATS_FILE)) {
  fs.writeFileSync(STATS_FILE, JSON.stringify({ totalUsers: [], totalDownloads: 0 }));
}

// Функция для обновления статистики
function updateStats(userId) {
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    if (!stats.totalUsers.includes(userId)) {
      stats.totalUsers.push(userId);
    }
    stats.totalDownloads += 1;
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('Ошибка записи статистики:', err);
  }
}

// Промис-обертка для запуска консольных команд (yt-dlp, ffmpeg)
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Функция быстрого разбиения видео на части без потери качества (стрим-копирование)
async function splitVideo(inputPath, outputDir, baseName) {
  // Получаем длительность видео в секундах с помощью ffprobe
  const durationStr = await runCommand(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nocreey=1 "${inputPath}"`);
  const duration = parseFloat(durationStr);
  
  const stats = fs.statSync(inputPath);
  const fileSize = stats.size;

  const partsCount = Math.ceil(fileSize / TG_FILE_LIMIT);
  const partDuration = Math.floor(duration / partsCount);
  const chunkPaths = [];

  for (let i = 0; i < partsCount; i++) {
    const startTime = i * partDuration;
    const chunkPath = path.join(outputDir, `${baseName}_part_${i + 1}.mp4`);
    
    let cmd = `ffmpeg -y -ss ${startTime} -i "${inputPath}" -t ${partDuration} -c copy "${chunkPath}"`;
    if (i === partsCount - 1) {
      // Последняя часть забирает всё оставшееся время до конца
      cmd = `ffmpeg -y -ss ${startTime} -i "${inputPath}" -c copy "${chunkPath}"`;
    }
    
    await runCommand(cmd);
    chunkPaths.push(chunkPath);
  }
  return chunkPaths;
}

// Логика скачивания и отправки файлов
async function startDownload(ctx, url, action, userId) {
  const outputFilename = `yt_${userId}_${Date.now()}`;
  const downloadDir = path.join(__dirname, 'downloads');
  
  if (!fs.existsSync(downloadDir)){
      fs.mkdirSync(downloadDir);
  }

  let command = '';
  let finalExtension = '';

  if (action === 'download_video') {
    finalExtension = 'mp4';
    // Скачиваем видео со звуком (лучший mp4 формат)
    command = `yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]" --merge-output-format mp4 -o "${path.join(downloadDir, outputFilename)}.% (ext)s" "${url}"`;
  } else if (action === 'download_audio') {
    finalExtension = 'mp3';
    // Вырезаем аудио, перекодируем в MP3, вшиваем превью ролика как обложку и добавляем теги автора/названия
    command = `yt-dlp -x --audio-format mp3 --embed-thumbnail --embed-metadata -o "${path.join(downloadDir, outputFilename)}.%(ext)s" "${url}"`;
  }

  try {
    ctx.reply('Начинаю скачивание и обработку медиафайла. Пожалуйста, подождите...');
    await runCommand(command);
    
    const expectedFilePath = path.join(downloadDir, `${outputFilename}.${finalExtension}`);

    if (!fs.existsSync(expectedFilePath)) {
      throw new Error('Файл не был создан утилитой yt-dlp.');
    }

    const stats = fs.statSync(expectedFilePath);

    if (action === 'download_video') {
      // Проверяем лимит 50 МБ
      if (stats.size > TG_FILE_LIMIT) {
        ctx.reply(`⚠️ Файл весит ${(stats.size / 1024 / 1024).toFixed(1)} МБ (лимит Telegram 50 МБ).\nНарезаю видео на части без потери качества...`);
        
        const parts = await splitVideo(expectedFilePath, downloadDir, outputFilename);
        
        for (let i = 0; i < parts.length; i++) {
          await ctx.reply(`📤 Отправляю часть ${i + 1} из ${parts.length}...`);
          await ctx.replyWithVideo({ source: parts[i] });
          if (fs.existsSync(parts[i])) fs.unlinkSync(parts[i]); // Чистим фрагмент
        }
        
        if (fs.existsSync(expectedFilePath)) fs.unlinkSync(expectedFilePath); // Чистим оригинал
      } else {
        // Маленькое видео шлем целиком
        await ctx.reply('📤 Отправляю видео...');
        await ctx.replyWithVideo({ source: expectedFilePath });
        if (fs.existsSync(expectedFilePath)) fs.unlinkSync(expectedFilePath);
      }
    } else {
      // Отправка аудио с обложкой
      await ctx.reply('📤 Отправляю аудиодорожку...');
      await ctx.replyWithAudio({ source: expectedFilePath });
      if (fs.existsSync(expectedFilePath)) fs.unlinkSync(expectedFilePath);
    }

    // Записываем успешное скачивание в статистику
    updateStats(userId);

  } catch (error) {
    console.error('Ошибка в процессе обработки:', error);
    ctx.reply('❌ Не удалось обработать ссылку. Возможно, видео защищено, удалено или временно недоступно.');
  }
}

// --- КОМАНДЫ БОТА ---

bot.start((ctx) => {
  ctx.reply('Привет! Отправь мне ссылку на обычное видео YouTube или Shorts, и я помогу тебе скачать медиафайл.');
});

// Команда для админа
bot.command('admin', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('У вас нет прав администратора.');
  }
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    ctx.reply(`📊 *Статистика бота:*\n\n👤 Уникальных пользователей: ${stats.totalUsers.length}\n📥 Всего скачиваний: ${stats.totalDownloads}`, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply('Не удалось прочитать файл статистики.');
  }
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
  const url = ctx.message.text.trim();

  if (!url.includes('://youtube.com') && !url.includes('youtu.be/')) {
    return ctx.reply('Пожалуйста, отправьте корректную ссылку на YouTube.');
  }

  // Автоматический перехват Shorts
  if (url.includes('/shorts/')) {
    ctx.reply('🎬 Обнаружен YouTube Shorts! Качаю сразу в формате видео...');
    return startDownload(ctx, url, 'download_video', ctx.from.id);
  }

  // Сохраняем сессию и предлагаем выбор для обычного видео
  userSessions.set(ctx.from.id, url);

  await ctx.reply('В каком формате скачать это видео?', 
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🎬 Видео (MP4)', 'download_video'),
        Markup.button.callback('🎵 MP3 Аудио (с обложкой)', 'download_audio')
      ]
    ])
  );
});

// Обработка кнопок выбора формата
bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const action = ctx.data;
  const url = userSessions.get(userId);

  if (!url) {
    return ctx.answerCbQuery('Ссылка устарела или не найдена. Отправьте её заново.', { show_alert: true });
  }

  // Убираем кнопки и меняем текст сообщения, чтобы избежать повторных кликов
  await ctx.editMessageText('Запрос принят, подготавливаю окружение...');
  await ctx.answerCbQuery();

  await startDownload(ctx, url, action, userId);
  userSessions.delete(userId); // Закрываем сессию
});

// Запуск простейшего HTTP-сервера, чтобы хостинги (Render, Amvera) не выключали бота по таймауту портов
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Бот успешно работает в фоновом режиме!');
}).listen(PORT, () => {
  console.log(`Веб-сервер запущен на порту ${PORT}`);
});

// Запуск бота
bot.launch()
  .then(() => console.log('🚀 Бот успешно запущен и готов к работе!'))
  .catch((err) => console.error('Ошибка старта бота:', err));

// Плавная остановка процесса при сигналах системы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

