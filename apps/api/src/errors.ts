/**
 * Один формат помилки на весь API (`02-CODE-RULES`):
 * `{ "error": { "code": …, "message": …, "details": {} } }`.
 *
 * Кодів рівно пʼять, і **`FORBIDDEN` серед них немає навмисно**. Запит до
 * чужого проєкту віддає `NOT_FOUND`, а не `403`: 403 підтверджує, що ресурс
 * існує, і перетворює перебір ідентифікаторів на розвідку чужого обсягу.
 * Це рішення закріплює тест ізоляції орендарів (T041).
 */
export const ERROR_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const

export type ErrorCode = keyof typeof ERROR_STATUS
export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode]

export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode
    readonly message: string
    readonly details: Record<string, unknown>
  }
}

/**
 * `details` завжди обʼєкт, хай і порожній. Поле, яке то є, то немає, змушує
 * кожного клієнта писати перевірку на існування — а формат помилки читають
 * саме тоді, коли вже щось пішло не так.
 */
export const errorBody = (
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ErrorBody => ({ error: { code, message, details } })

/**
 * Помилка, яку код кидає навмисно і чиє повідомлення **призначене користувачу**.
 * Усе інше, що долетить до обробника, вважається неочікуваним і назовні
 * не пояснюється — див. `app.ts`.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  get status(): ErrorStatus {
    return ERROR_STATUS[this.code]
  }

  toBody(): ErrorBody {
    return errorBody(this.code, this.message, this.details)
  }
}
