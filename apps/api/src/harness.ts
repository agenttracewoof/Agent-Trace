/**
 * Точка входу для наскрізного сценарію (`packages/e2e`, T036) — і більше ні для
 * чого. Сценарій мусить піднімати **той самий** застосунок, який їде у продакшн:
 * копія маршрутів усередині тесту доводила б, що працює копія.
 *
 * Окремий файл, а не `index.ts`: той при імпорті одразу читає env і слухає порт,
 * тобто імпортувати його з процесу, який сам вирішує, де слухати, неможливо.
 */
export { createApp } from './app.js'
export { silentLogger } from './logger.js'
export { createProject } from './projects.js'
export { agentRoutes } from './routes/agents.js'
export { decisionRoutes } from './routes/decisions.js'
export { publicRoutes } from './routes/public.js'
