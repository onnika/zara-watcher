import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';

const stealth = stealthPlugin();
chromium.use(stealth);

const PRODUCTS_FILE = './products.json';

(async () => {
    // 1. Читаємо файл
    let products = [];
    try {
        const fileContent = await fs.readFile(PRODUCTS_FILE, 'utf-8');
        products = JSON.parse(fileContent);
    } catch (e) {
        console.error(`❌ Помилка читання ${PRODUCTS_FILE}.`);
        return;
    }

    // Рахуємо, скільки товарів треба оновити
    const productsToUpdate = products.filter(p => !p.skuToSize || Object.keys(p.skuToSize).length === 0);
    
    if (productsToUpdate.length === 0) {
        console.log("✅ Всі товари вже мають SKU. Відпочивай.");
        return;
    }

    console.log(`📋 Знайдено товарів для обробки: ${productsToUpdate.length}`);

    // 2. Запускаємо браузер (один раз для всіх сторінок)
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // 3. Запускаємо цикл по ВСІХ товарах
    for (let i = 0; i < products.length; i++) {
        const product = products[i];

        // Перевіряємо, чи треба оновлювати саме цей товар
        if (!product.skuToSize || Object.keys(product.skuToSize).length === 0) {
            
            console.log(`\n--------------------------------------------------`);
            console.log(`🎯 [${i + 1}/${products.length}] Обробляємо: "${product.name || 'Товар без назви'}"`);
            console.log(`🔗 URL: ${product.pageUrl}`);

            try {
                await page.goto(product.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                
                try {
                    // Шукаємо кнопку за текстом (Playwright це вміє ідеально)
                    const cookieBtn = page.getByRole('button', { name: 'ДОЗВОЛИТИ ВСІ ФАЙЛИ COOKIE' });
                    
                    // Чекаємо секунду, чи з'явиться вона
                    if (await cookieBtn.isVisible({ timeout: 2000 })) {
                        await cookieBtn.click();
                        console.log("🍪 Банер cookies закрито.");
                        await page.waitForTimeout(1000); // Даємо час сторінці "продихнути"
                    }
                } catch (e) {
                    console.log("🍪 Банер не з'явився (або вже закритий).");
                }

                const sizeData = await page.evaluate(() => {
                    try {
                        if (window.zara && window.zara.viewPayload && window.zara.viewPayload.product) {
                             const product = window.zara.viewPayload.product;
                             const map = {};
                             product.detail.colors.forEach(color => {
                                color.sizes.forEach(size => {
                                    map[size.sku] = size.name;
                                });
                             });
                             return map;
                        }
                        return null;
                    } catch (e) {
                        return null;
                    }
                });

                if (sizeData && Object.keys(sizeData).length > 0) {
                    console.log("✅ Дані отримано:");
                    console.table(sizeData);

                    // Оновлюємо об'єкт у пам'яті
                    products[i].skuToSize = sizeData;

                    // Зберігаємо файл ПІСЛЯ КОЖНОГО УСПІХУ
                    // Це безпечніше: якщо на 5-му товарі станеться помилка, перші 4 вже збережуться
                    await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf-8');
                    console.log(`💾 Progress saved to ${PRODUCTS_FILE}`);

                } else {
                    console.log("⚠️ Не вдалося знайти SKU для цього товару (можливо, інша структура сторінки).");
                }

            } catch (e) {
                console.error(`❌ Помилка при обробці товару: ${e.message}`);
            }

            // Додаткова пауза між товарами, щоб Akamai не заблокував за "надто швидкий перегляд"
            console.log("⏳ Чекаємо 3 секунди перед наступним товаром...");
            await page.waitForTimeout(3000); 
        }
    }

    console.log(`\n🎉 Роботу завершено!`);
    await browser.close();
})();