import fs from "fs";
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

const stealth = stealthPlugin();
chromium.use(stealth);

// Папка, де буде жити "пам'ять" бота
const USER_DATA_DIR = "./zara_session";

async function loginAndSave() {
    console.log("🚀 Відкриваю браузер для входу...");
    console.log("👉 Твоє завдання: Просто залогінься руками на сайті.");

    // Відкриваємо браузер із постійним профілем
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false, // Щоб ти бачила вікно
        channel: "chrome", // Використовуємо справжній Chrome (якщо встановлений), це надійніше
        viewport: { width: 1280, height: 800 }
    });

    const page = await context.pages()[0] || await context.newPage();
    
    await page.goto("https://www.zara.com/ua/uk/logon", { waitUntil: "domcontentloaded" });

    // Чекаємо, поки ти залогінишся (перевіряємо, чи з'явилось "Мій обліковий запис")
    console.log("⏳ Чекаю, поки ти увійдеш в акаунт...");
    
    // Чекаємо до нескінченності, поки URL не зміниться на сторінку акаунту або не з'явиться елемент профілю
    // Ми просто чекаємо 5 хвилин, щоб ти встигла все ввести
    await page.waitForTimeout(5000); 

    // Цикл перевірки: чи ми вже залогінені?
    let isLoggedIn = false;
    while (!isLoggedIn) {
        try {
            // Перевіряємо куки на наявність 'z_user_id' (ознака входу) або просто чекаємо твоєї команди в консолі
            const cookies = await context.cookies();
            const sessionCookie = cookies.find(c => c.name === "wk_d2" || c.name === "z_user_id");
            
            if (sessionCookie) {
                console.log("✅ Бачу сесію! Зберігаю дані...");
                
                // Формуємо рядок Cookie для fetch-запитів
                const cookieString = cookies
                    .map(c => `${c.name}=${c.value}`)
                    .join("; ");
                
                // Зберігаємо у файл cookies.txt
                fs.writeFileSync("./cookies.txt", cookieString);
                console.log("💾 Куки збережено у 'cookies.txt'");
                isLoggedIn = true;
            } else {
                console.log("... ще не залогінена. Чекаю 5 сек...");
                await page.waitForTimeout(5000);
            }
        } catch (e) {
            console.log("Помилка перевірки:", e.message);
            await page.waitForTimeout(5000);
        }
    }

    console.log("🎉 Готово! Тепер бот пам'ятатиме тебе.");
    console.log("Можеш закривати браузер.");
    
    // Не закриваємо автоматично, щоб ти переконалась, що все ок
    // await context.close(); 
}

loginAndSave();