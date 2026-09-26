# Съёмка мини-аппа в модели смартфона

`npm run screenshots:miniapp` по умолчанию использует `smartphone`.
`npm run audit:miniapp:visual` и `npm run emulator:miniapp` также используют этот режим.
Существующие пресеты `smoke` и `moderation` сохраняют прежний `native` для совместимости;
для новой модели явно укажите `MINIAPP_SCREENSHOT_TARGET=smartphone`.

## Что воспроизводится

| Профиль                          | Движок   | Экран, CSS px | Область WebView | DPR   |
| -------------------------------- | -------- | ------------- | --------------- | ----- |
| android / Pixel 7                | Chromium | 412 × 915     | 412 × 811       | 2.625 |
| iphone / iPhone 15               | WebKit   | 393 × 852     | 393 × 749       | 3     |
| iphone-se / SE первого поколения | WebKit   | 320 × 568     | 320 × 504       | 2     |

Размеры экрана берутся из установленной версии Playwright. Верхняя системная область
и заголовок MAX вычитаются из области WebView. Верхний safe-area внутри WebView равен нулю,
чтобы не учитывать его второй раз. Нижний inset iPhone 15 остаётся внутри WebView (34px);
нижняя системная панель Android вынесена за его пределы (24px).
Включены mobile viewport, touch, русская локаль, московский часовой пояс и MAX Bridge shim.

Для каждого состояния сохраняются:

- `<scenario>.png`: непосредственно WebView, без декоративной рамки;
- `<scenario>-phone.png`: тот же интерфейс с условными системными панелями и заголовком MAX;
- `report.json`: движок, версия, экран, layout/visual viewport, DPR, safe-area, сценарий,
  тема, результаты проверок и модель клавиатуры;
- при ошибке: `-failed.png`, по возможности `-failed-phone.png` и причина в отчёте.

Режим smartphone продолжает съёмку после ошибки отдельного сценария и возвращает ненулевой
код завершения в конце. `MINIAPP_SCREENSHOT_CONTINUE_ON_FAILURE=0` включает раннюю остановку.
Аудит собирает результаты всех комбинаций устройств и тем перед завершением.
Перед замерами загружаются шрифты и завершаются конечные CSS-анимации: промежуточный масштаб
открывающейся панели не выдаётся за дефект её окончательной геометрии.

## Команды

```bash
# Установка движков, если они ещё не установлены
npx playwright install --with-deps chromium webkit

# Основные экраны на iPhone, тёмная тема
MINIAPP_SCREENSHOT_TARGET=smartphone \
MINIAPP_SCREENSHOT_DEVICE=iphone \
MINIAPP_SCREENSHOT_COLOR_SCHEME=dark \
MINIAPP_SCREENSHOT_SCENARIOS=home,chat-settings,channel-stats,events-participants \
npm run screenshots:miniapp

# Полный существующий набор Major с новой моделью телефона
MINIAPP_SCREENSHOT_PRESET=moderation \
MINIAPP_SCREENSHOT_TARGET=smartphone npm run screenshots:miniapp

# Клавиатура: три цикла открытия/закрытия с настоящим фокусом поля
MINIAPP_SCREENSHOT_TARGET=smartphone \
MINIAPP_SCREENSHOT_DEVICE=all \
MINIAPP_SCREENSHOT_SIMULATE_KEYBOARD=1 \
MINIAPP_SCREENSHOT_STRICT_LAYOUT=1 \
MINIAPP_SCREENSHOT_SCENARIOS=home,chat-settings,channel-dialog-comments,channel-dialog-suggest \
npm run screenshots:miniapp

# Интерактивное окно WebView; системные панели в нём не рисуются
npm run emulator:miniapp -- --device iphone --theme dark

# Проверка самого средства съёмки, включая пиксели итогового PNG
node apps/miniapp/test/smartphone-harness.browser.mjs
```

Для старого режима: `MINIAPP_SCREENSHOT_TARGET=native`,
`MINIAPP_VISUAL_AUDIT_TARGET=native` или `emulator:miniapp -- --target native`.
`MINIAPP_SCREENSHOT_BROWSER=chromium|webkit|auto` и аналогичный
`MINIAPP_EMULATOR_BROWSER` позволяют отдельно проверить другой движок.
Старые режимы по умолчанию сохраняют Chromium. Без установленного нужного движка
smartphone завершается с понятной ошибкой, не подменяет его молча.

## Клавиатура

На iOS моделируется сокращение `visualViewport` при сохранении layout viewport.
На Android моделируется `adjustResize`; физический экран и ориентация сохраняются через CDP.
`MINIAPP_SCREENSHOT_KEYBOARD_MODE=visual|resize` переключает модель;
`MINIAPP_SCREENSHOT_KEYBOARD_OVERLAP_PX=320` задаёт высоту перекрытия.
В режиме smartphone скрипт не скрывает навигацию тестовыми стилями и не назначает
приложению флаг открытой клавиатуры: проверяется собственная реакция интерфейса.

## Калибровка по настоящему телефону

Панели телефона и MAX на составном снимке являются моделью, их значения не измерены
на конкретном установленном клиенте. Для точного сравнения измерьте доступную область
на устройстве и задайте `MINIAPP_PHONE_METRICS_PATH` с JSON-файлом:

```json
{
  "iphone": {
    "width": 393,
    "height": 852,
    "statusBarHeight": 59,
    "headerHeight": 44,
    "systemBottom": 0,
    "safeBottom": 34
  }
}
```

Все значения задаются в CSS px. Это пример исходного пресета, а не измерение MAX.
Неизвестные параметры, отрицательные/дробные значения и невозможная геометрия отвергаются.
Измерения меняют только средство съёмки, не стили приложения.

Playwright WebKit не равен установленному WKWebView; версия user-agent не доказывает
версию iOS. Проверка использует preview-данные, а не аккаунт владельца. Системная клавиатура,
нативные жесты закрытия, выбор файлов, реальный Bridge и масштаб текста ОС требуют
отдельного прогона на телефоне. В Linux WebKit может сообщать `maxTouchPoints=0` при работающем
touch; браузерная проверка проверяет само событие касания, а не только это свойство.
