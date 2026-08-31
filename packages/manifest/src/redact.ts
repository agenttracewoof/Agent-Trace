const WILDCARD = '*'

const DROP = Symbol('redact/drop')

type Rule = readonly string[]

function parseRule(rule: string): Rule {
  const segments = rule.split('.')
  if (segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`redact: malformed allow rule ${JSON.stringify(rule)}`)
  }
  return segments
}

function isDropped(value: unknown): boolean {
  return value === DROP
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Усе, чого редактор не впізнав, він не публікує: список тут допускає, а не
 * забороняє. Новий різновид значення з'явиться колись у чужому агенті, і ціна
 * помилки несиметрична — опублікований у ланцюг секрет забрати назад неможливо.
 */
function isPublishable(value: unknown): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object':
      return value === null
    default:
      return false
  }
}

function descend(rules: readonly Rule[], segment: string): Rule[] {
  const next: Rule[] = []
  for (const rule of rules) {
    const head = rule[0]
    if (head === segment || head === WILDCARD) next.push(rule.slice(1))
  }
  return next
}

function walk(value: unknown, rules: readonly Rule[]): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value.map((item) => walk(item, descend(rules, WILDCARD)))
    if (items.every(isDropped)) return DROP

    // Позиція елемента зберігається: якщо з елемента нічого не публікується,
    // на його місці лишається null. Інакше номер джерела у записі не збігався б
    // з номером у самому рішенні.
    return items.map((item) => (isDropped(item) ? null : item))
  }

  if (isPlainObject(value)) {
    const entries: [string, unknown][] = []
    for (const [key, item] of Object.entries(value)) {
      const kept = walk(item, descend(rules, key))
      if (!isDropped(kept)) entries.push([key, kept])
    }
    return entries.length === 0 ? DROP : Object.fromEntries(entries)
  }

  const matched = rules.some((rule) => rule.length === 0)
  return matched && isPublishable(value) ? value : DROP
}

/**
 * Лишає у значенні тільки те, що політика назвала поіменно. Правило адресує
 * **лист**, а не піддерево: `call` над об'єктом не публікує нічого, потрібне
 * `call.model`. Інакше поле, яке агент почне писати завтра, опублікувало б себе
 * саме — а це вже deny-list із його звичайним кінцем.
 *
 * Сегмент `*` збігається з будь-яким ключем; елементи масиву адресуються тільки
 * ним. Секрет, який лежить *усередині* дозволеного значення, редакція не бачить —
 * межа проходить по полях, і вибір полів робить автор політики.
 */
export function redact(value: unknown, allow: readonly string[]): unknown {
  const result = walk(value, allow.map(parseRule))
  return isDropped(result) ? null : result
}
