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

// Настройка одновременных скачиваний под 1 ГБ RAM хостинга
const MAX_CONCURRENT_DOWNLOADS = 2; 

const userSessions = new Map();
const downloadQueue = []; 
let activeDownloadsCount = 0; 

// Файлы базы данных и логов
const STATS_FILE = path.join(__dirname, 'stats.json');
const LOGS_FILE = path.join(__dirname, 'logs.json');

// Инициализация файлов конфигурации
if (!fs.existsSync(STATS_FILE)) {
  fs.writeFileSync(STATS_FILE, JSON.stringify({ totalUsers: [], totalDownloads: 0 }));
}
if (!fs.existsSync(LOGS_FILE)) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify([]));
}

// Улучшенная функция логирования (сохраняет тип события, дату, юзера и детали)
function logEvent(type, userId, username, details = '', errorStack = '') {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
    const newLog = {
      timestamp: new Date().toISOString(),
      dateStr: new Date().toLocaleDateString('ru-RU'),
      type, // 'REQUEST', 'SUCCESS', 'ERROR'
      userId,
      username: username || 'unknown',
      details,
      error: errorStack || null
    };
    logs.push(newLog);
    if (logs.length > 1000) logs.shift(); // Храним только последние 1000 записей
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error('Ошибка записи логов:', err);
  }
}

// Функция для обновления общей статистики
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

// Обертка для запуска консольных команд
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) reject(error || stderr);
      else resolve(stdout);
    });
  });
}

// Функция быстрого разбиения видео на части без потери качества через ffmpeg
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

// Менеджер очереди задач
function enqueueDownload(ctx, url, action, userId) {
  downloadQueue.push({ ctx, url, action, userId, notified: false });
  logEvent('REQUEST', userId, ctx.from.username, `Тип: ${action}, URL: ${url}`);
  processQueue();
}

async function processQueue() {
  if (activeDownloadsCount >= MAX_CONCURRENT_DOWNLOADS || downloadQueue.length === 0) {
    downloadQueue.forEach((task, index) => {
      if (!task.notified) {
        task.ctx.reply(`⏳ Все линии заняты. Вы добавлены в очередь ожидания. Ваша позиция: ${index + 1}`);
        task.notified = true;
      }
    });
    return;
  }

  const currentTask = downloadQueue.shift();
  activeDownloadsCount++;

  try {
    await executeDownload(currentTask.ctx, currentTask.url, currentTask.action, currentTask.userId);
  } catch (error) {
    console.error('Ошибка в очереди:', error);
  } finally {
    activeDownloadsCount--;
    processQueue();
  }
}

// Основная логика скачивания через yt-dlp
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
    logEvent('SUCCESS', userId, ctx.from.username, `Успешно отправлено: ${action}`);

  } catch (error) {
    const errorMsg = error.message || String(error);
    console.error('Ошибка:', errorMsg);
    logEvent('ERROR', userId, ctx.from.username, `Ошибка скачивания: ${action}, URL: ${url}`, errorMsg);
    await ctx.reply('❌ Не удалось обработать ссылку. Возможно, видео защищено, содержит региональные ограничения или удалено.');
  }
}

// --- КОМАНДЫ БОТА ---

bot.start((ctx) => {
  ctx.reply('Привет! Отправь мне ссылку на видео YouTube или Shorts, и я помогу тебе скачать его.');
});

// Кнопки Главного Админ-Меню
function getAdminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄 Скачать текстовый лог', 'admin_get_log')],
    [
      Markup.button.callback('🔄 Обновить', 'admin_refresh'),
      Markup.button.callback('🗑 Очистить логи', 'admin_clear_log')
    ]
  ]);
}

// Генерация текста админ-панели с детализацией за день
function generateAdminReport() {
  const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
  
  const todayStr = new Date().toLocaleDateString('ru-RU');
  
  const todayLogs = logs.filter(l => l.dateStr === todayStr);
  const todayRequests = todayLogs.filter(l => l.type === 'REQUEST').length;
  const todaySuccess = todayLogs.filter(l => l.type === 'SUCCESS').length;
  const todayErrors = todayLogs.filter(l => l.type === 'ERROR');

  let report = `📊 *АДМИН-ПАНЕЛЬ СТАТИСТИКИ*\n\n`;
  report += `👥 *Всего пользователей:* ${stats.totalUsers.length}\n`;
  report += `📥 *Всего скачиваний:* ${stats.totalDownloads}\n`;
  report += `⚙️ *Активных потоков:* ${activeDownloadsCount} / ${MAX_CONCURRENT_DOWNLOADS}\n`;
  report += `⏳ *Задач в очереди:* ${downloadQueue.length}\n\n`;
  
  report += `📅 *ДЕТАЛИЗАЦИЯ ЗА СЕГОДНЯ (${todayStr}):*\n`;
  report += `💬 Получено запросов: ${todayRequests}\n`;
  report += `✅ Успешных загрузок: ${todaySuccess}\n`;
  report += `❌ Ошибок за день: ${todayErrors.length}\n\n`;

  if (todayErrors.length > 0) {
    report += `⚠️ *Последние ошибки за сутки (макс. 3):*\n`;
    todayErrors.slice(-3).forEach((err, idx) => {
      const time = new Date(err.timestamp).toLocaleTimeString('ru-RU');
      report += `${idx + 1}. [${time}] @${err.username}: _${err.details}_\n`;
      if (err.error) {
        report += `└ 🛑 \`${err.error.substring(0, 120)}...\`\n`;
      }
    });
  } else {
    report += `🎉 Ошибок за сегодня не зафиксировано!`;
  }

  return report;
}

bot.command('admin', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('У вас нет прав администратора.');
  ctx.reply(generateAdminReport(), { parse_mode: 'Markdown', reply_markup: getAdminKeyboard().reply_markup });
});

// Обработка действий в админ-панели
bot.on('callback_query', async (ctx) => {
  const action = ctx.data;
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Отказано в доступе', { show_alert: true });

  if (action === 'admin_refresh') {
    await ctx.editMessageText(generateAdminReport(), { parse_mode: 'Markdown', reply_markup: getAdminKeyboard().reply_markup });
    await ctx.answerCbQuery('Данные обновлены');
  } 
  
  else if (action === 'admin_get_log') {
    await ctx.answerCbQuery('Формирую файл логов...');
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
    
    let textLog = `=== ПОЛНЫЙ ЛОГ РАБОТЫ БОТА ===\n Generated: ${new Date().toLocaleString('ru-RU')}\n\n`;
    logs.forEach(l => {
      textLog += `[${l.timestamp}] [${l.type}] User: ID ${l.userId} (@${l.username})\n`;
      textLog += `   Действие: ${l.details}\n`;
      if (l.error) textLog += `   КРИТИЧЕСКАЯ ОШИБКА: ${l.error}\n`;
      textLog += `--------------------------------------------------\n`;
    });

    const tempLogPath = path.join(__dirname, 'full_log.txt');
    fs.writeFileSync(tempLogPath, textLog);

    await ctx.replyWithDocument({ source: tempLogPath, filename: `bot_log_${Date.now()}.txt` });
    if (fs.existsSync(tempLogPath)) fs.unlinkSync(tempLogPath);
  } 
  
  else if (action === 'admin_clear_log') {
    fs.writeFileSync(LOGS_FILE, JSON.stringify([]));
    await ctx.editMessageText(generateAdminReport(), { parse_mode: 'Markdown', reply_markup: getAdminKeyboard().reply_markup });
    await ctx.answerCbQuery('Журнал логов успешно очищен!', { show_alert: true });
  }

  // Обработка пользовательских кнопок выбора качества/формата
  else {
    const userId = ctx.from.id;
    const url = userSessions.get(userId);

    if (!url) return ctx.answerCbQuery('Ссылка устарела.', { show_alert: true });

    await ctx.editMessageText('Запрос принят. Добавляю в систему обработки...');
    await ctx.answerCbQuery();

    enqueueDownload(ctx, url, action, userId);
    userSessions.delete(userId);
  }
});

bot.on('text', async (ctx) => {
  const url = ctx.message.text.trim();

  if (!url.includes('://youtube.com') && !url.includes('youtu.be/')) {
    return ctx.reply('Пожалуйста, отправьте корректную ссылку на YouTube.');
  }

  if (url.includes('/shorts/')) {
    ctx.reply('🎬 Обнаружен Shorts! Добавляю видео в очередь...');
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

// Запускаем веб-сервер, чтобы Bothost поддерживал активность контейнера
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Бот активен!');
}).listen(PORT);

bot.launch()
  .then(() => console.log('🚀 Бот запущен!'))
  .catch((err) => console.error('Ошибка старта:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


