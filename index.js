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

// НАСТРОЙКА ОЧЕРЕДИ: Сколько видео разрешено качать ОДНОВРЕМЕННО
// Для 1 ГБ RAM оптимально поставить 2 (максимум 3), чтобы сервер не упал
const MAX_CONCURRENT_DOWNLOADS = 2; 

// Хранилища для сессий и очереди
const userSessions = new Map();
const downloadQueue = []; // Массив для задач в очереди
let activeDownloadsCount = 0; // Счетчик запущенных в данный момент скачиваний

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

// Функция быстрого разбиения видео на части без потери качества
async function splitVideo(inputPath, outputDir, baseName) {
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
      cmd = `ffmpeg -y -ss ${startTime} -i "${inputPath}" -c copy "${chunkPath}"`;
    }
    
    await runCommand(cmd);
    chunkPaths.push(chunkPath);
  }
  return chunkPaths;
}

// Функция добавления задачи в очередь
function enqueueDownload(ctx, url, action, userId) {
  // Добавляем задачу в конец массива
  downloadQueue.push({ ctx, url, action, userId });
  
  // Проверяем, можно ли запустить её прямо сейчас
  processQueue();
}

// Главный менеджер очереди
async function processQueue() {
  // Если свободных слотов нет или очередь пуста — ничего не делаем
  if (activeDownloadsCount >= MAX_CONCURRENT_DOWNLOADS || downloadQueue.length === 0) {
    // Оповещаем пользователей в очереди об их текущей позиции
    downloadQueue.forEach((task, index) => {
      // Отправляем уведомление только если это новая задача на первой позиции ожидания
      if (index >= 0 && !task.notified) {
        task.ctx.reply(`⏳ Все линии заняты. Вы добавлены в очередь ожидания. Ваша позиция: ${index + 1}`);
        task.notified = true; // Чтобы не спамить сообщениями
      }
    });
    return;
  }

  // Берем первую задачу из очереди
  const currentTask = downloadQueue.shift();
  activeDownloadsCount++; // Занимаем слот процесса

  try {
    await executeDownload(currentTask.ctx, currentTask.url, currentTask.action, currentTask.userId);
  } catch (error) {
    console.error('Критическая ошибка при выполнении задачи из очереди:', error);
  } finally {
    activeDownloadsCount--; // Освобождаем слот после завершения (успешного или с ошибкой)
    processQueue(); // Рекурсивно запускаем проверку для следующей задачи
  }
}

// Логика скачивания и отправки файлов (теперь вызывается через менеджер очереди)
async function executeDownload(ctx, url, action, userId) {
  const outputFilename = `yt_${userId}_${Date.now()}`;
  const downloadDir = path.join(__dirname, 'downloads');
  
  if (!fs.existsSync(downloadDir)){
      fs.mkdirSync(downloadDir);
  }

  let command = '';
  let finalExtension = '';

  if (action === 'download_video') {
    finalExtension = 'mp4';
    command = `yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]" --merge-output-format mp4 -o "${path.join(downloadDir, outputFilename)}.% (ext)s" "${url}"`;
  } else if (action === 'download_audio') {
    finalExtension = 'mp3';
    command = `yt-dlp -x --audio-format mp3 --embed-thumbnail --embed-metadata -o "${path.join(downloadDir, outputFilename)}.%(ext)s" "${url}"`;
  }

  try {
    await ctx.reply('🚀 Ваша очередь подошла! Начинаю скачивание и обработку файла...');
    await runCommand(command);
    
    const expectedFilePath = path.join(downloadDir, `${outputFilename}.${finalExtension}`);

    if (!fs.existsSync(expectedFilePath)) {
      throw new Error('Файл не был создан утилитой yt-dlp.');
    }

    const stats = fs.statSync(expectedFilePath);

    if (action === 'download_video') {
      if (stats.size > TG_FILE_LIMIT) {
        await ctx.reply(`⚠️ Файл весит ${(stats.size / 1024 / 1024).toFixed(1)} МБ.\nНарезаю видео на части без потери качества...`);
        const parts = await splitVideo(expectedFilePath, downloadDir, outputFilename);
        
        for (let i = 0; i < parts.length; i++) {
          await ctx.reply(`📤 Отправляю часть ${i + 1} из ${parts.length}...`);
          await ctx.replyWithVideo({ source: parts[i] });
          if (fs.existsSync(parts[i])) fs.unlinkSync(parts[i]);
        }
        if (fs.existsSync(expectedFilePath)) fs.unlinkSync(expectedFilePath);
      } else {
        await ctx.reply('📤 Отправляю видео...');
        await ctx.replyWithVideo({ source: expectedFilePath });
        if (fs.existsSync(expectedFilePath)) fs.unlinkSync(expectedFilePath);
      }
    } else {
      await ctx.reply('📤 Отправляю аудиодорожку...');
      await ctx.replyWithAudio({ source: expectedFilePath });
      if (fs.existsSync(expectedFilePath)) fs.unlinkSync(expectedFilePath);
    }

    updateStats(userId);

  } catch (error) {
    console.error('Ошибка в процессе обработки:', error);
    await ctx.reply('❌ Не удалось обработать ссылку. Возможно, видео защищено или удалено.');
  }
}

// --- КОМАНДЫ БОТА ---

bot.start((ctx) => {
  ctx.reply('Привет! Отправь мне ссылку на обычное видео YouTube или Shorts, и я поставлю его в очередь на скачивание.');
});

bot.command('admin', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('У вас нет прав администратора.');
  }
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    ctx.reply(`📊 *Статистика бота:*\n\n👤 Уникальных пользователей: ${stats.totalUsers.length}\n📥 Всего скачиваний: ${stats.totalDownloads}\n🔄 Сейчас качается: ${activeDownloadsCount}\n⏳ В очереди ожидания: ${downloadQueue.length}`, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply('Не удалось прочитать файл статистики.');
  }
});

bot.on('text', async (ctx) => {
  const url = ctx.message.text.trim();

  if (!url.includes('://youtube.com') && !url.includes('youtu.be/')) {
    return ctx.reply('Пожалуйста, отправьте корректную ссылку на YouTube.');
  }

  if (url.includes('/shorts/')) {
    ctx.reply('🎬 Обнаружен YouTube Shorts! Добавляю видео в очередь...');
    return enqueueDownload(ctx, url, 'download_video', ctx.from.id);
  }

  userSessions.set(ctx.from.id, url);

  await ctx.reply('В каком формате скачать это видео?', 
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🎬 Видео (MP4)', 'download_video'),
        Markup.button.callback('🎵 MP3 Аудио', 'download_audio')
      ]
    ])
  );
});

bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const action = ctx.data;
  const url = userSessions.get(userId);

  if (!url) {
    return ctx.answerCbQuery('Ссылка устарела. Отправьте её заново.', { show_alert: true });
  }

  await ctx.editMessageText('Запрос принят. Добавляю в систему обработки...');
  await ctx.answerCbQuery();

  // Отправляем задачу в очередь вместо немедленного скачивания
  enqueueDownload(ctx, url, action, userId);
  userSessions.delete(userId);
});

// HTTP-сервер для удержания процесса на Bothosts / Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Бот активен!');
}).listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

bot.launch()
  .then(() => console.log('🚀 Бот с защитой памяти RAM успешно запущен!'))
  .catch((err) => console.error('Ошибка старта:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
