import fs from "fs";
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

const stealth = stealthPlugin();
chromium.use(stealth);

// Папка для профілю
const USER_DATA_DIR = "./zara_session";

async function loginAndSave() {
    console.log("🚀 Відкриваю браузер...");
    console.log("🧹 Створюю чистий профіль (або завантажую існуючий)...");
    
    // Відкриваємо браузер
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false, 
        channel: "chrome", 
        viewport: { width: 1280, height: 800 },
        // Маскування під людину
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await context.pages()[0] || await context.newPage();
    
    console.log("🌍 Йдемо на сайт Zara...");
    await page.goto("https://www.zara.com/ua/uk/logon", { waitUntil: "domcontentloaded" });

    console.log("\n🛑 УВАГА: Я НЕ БУДУ ЗАКРИВАТИСЯ САМ!");
    console.log("👉 1. Введи логін і пароль.");
    console.log("👉 2. Переконайся, що ти бачиш своє ім'я або історію замовлень.");
    console.log("👉 3. ТІЛЬКИ КОЛИ ВСЕ ГОТОВО — ЗАКРИЙ ВІКНО БРАУЗЕРА ХРЕСТИКОМ (❌).");
    console.log("⏳ Чекаю, поки ти закриєш браузер...");

    // Магія: скрипт просто чекає, поки зникнуть усі сторінки (тобто ти закриєш браузер)
    await new Promise(resolve => {
        context.on('close', resolve);
        // Або перевіряємо кожну секунду, чи браузер ще відкритий
        const interval = setInterval(() => {
            if (context.pages().length === 0) {
                clearInterval(interval);
                resolve();
            }
        }, 1000);
    });

    console.log("\n🔒 Браузер закрито. Зберігаю дані...");

    // Оскільки контекст закрився, ми не можемо взяти куки прямо з нього.
    // АЛЕ! Playwright вже автоматично зберіг все в папку 'zara_session'.
    // Нам треба лише дістати куки для API запитів з файлу Cookies профілю (це складно),
    // АБО просто перезапустити контекст на секунду, щоб дістати текстові куки.
    
    // Перевідкриваємо на секунду, щоб витягнути текст куків для fetch
    const tempContext = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: true });
    const cookies = await tempContext.cookies();
    
    const cookieString = cookies
        .map(c => `${c.name}=${c.value}`)
        .join("; ");
    
    fs.writeFileSync("./cookies.txt", cookieString);
    await tempContext.close();

    console.log(`💾 Збережено ${cookies.length} штук кукі у файл 'cookies.txt'`);
    console.log("✅ Папка 'zara_session' оновлена.");
    console.log("🎉 Тепер запускай снайпера!");
}

loginAndSave();