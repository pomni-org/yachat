# ЯЧат

Локальный desktop/web-мессенджер на Electron с подготовкой статической web-версии для Vercel.

## Важно по безопасности

Пользовательские runtime-данные, локальные хранилища и секреты не должны попадать в GitHub.
Для этого добавлены `.gitignore` и `.vercelignore`.

## Запуск desktop-версии

```powershell
npm run start
```

## Проверки

```powershell
npm run check
npm run build:vercel
python -m py_compile api/index.py
```

## Vercel

Vercel-сборка копирует файлы интерфейса в `public` и поднимает Python API для безопасной передачи публичного списка пользователей из внешней БД.

Подробности: `docs/VERCEL.md`.
