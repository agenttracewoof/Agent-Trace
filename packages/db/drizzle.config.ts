import { defineConfig } from 'drizzle-kit'

/**
 * `generate` працює офлайн — з самої схеми, без бази. Тому `DATABASE_URL` тут
 * необовʼязковий: міграції мають генеруватися й на CI, де бази немає взагалі.
 * Порожній рядок валить лише `migrate`, і валить голосно, а не мовчки в нікуди.
 */
export default defineConfig({
  dialect: 'postgresql',
  /**
   * Файли перелічені поіменно, а не глобом `*.ts`: глоб затягнув би сюди
   * `*.test.ts`, які drizzle-kit виконує так само, як схему. Ціна — новий файл
   * схеми треба дописати сюди руками (найближчий — `auth.ts` на T037), і це
   * дешевше, ніж генератор, який мовчки читає тести.
   */
  schema: ['./src/schema/core.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})
