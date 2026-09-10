/**
 * `decisionId` живе у двох формах, і межа між ними названа: **32 hex без дефісів**
 * у форматі, у якорі й у публічному посиланні; `uuid` — у колонці бази. Дефіси
 * ставить одна функція, і саме тому вона окремий модуль, а не приватна деталь
 * приймання: щойно її скопіювали б у публічне читання, дві форми адреси почали б
 * розходитися — а адреса рішення це те, що людина копіює з ланцюга у браузер.
 */

/** 16 байтів у hex нижнього регістру — рівно те, що лежить у якорі. */
export const DECISION_ID_PATTERN = /^[0-9a-f]{32}$/

export const isDecisionIdShaped = (value: string): boolean => DECISION_ID_PATTERN.test(value)

/**
 * Викликати можна лише на вже перевіреній формі: з чогось іншого вийде рядок,
 * схожий на uuid, і Postgres відповість помилкою типу замість «не знайдено».
 */
export function asUuid(decisionId: string): string {
  return `${decisionId.slice(0, 8)}-${decisionId.slice(8, 12)}-${decisionId.slice(12, 16)}-${decisionId.slice(16, 20)}-${decisionId.slice(20)}`
}

/** Зворотний бік тієї самої межі: рядок бази → адреса, яку бачить світ. */
export const asDecisionId = (uuid: string): string => uuid.replaceAll('-', '')
