import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { projects } from './core.js'

/**
 * The four tables better-auth reads and writes, in the shape its drizzle
 * adapter expects with `usePlural: true`: the property names are better-auth's
 * field names, the column names are ours. `auth.test.ts` checks every field
 * against better-auth's own table list, so an upgrade that adds one fails
 * there instead of at the first sign-in.
 *
 * Ids are `uuid`, not better-auth's default random text, because
 * `agent_keys.confirmed_by` already is one — the API must run with
 * `advanced.database.generateId: 'uuid'`.
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(table.email),
    /**
     * better-auth lowercases the address before every lookup, so a mixed-case
     * row could never sign in — and the unique index would not stop
     * `A@x.io` and `a@x.io` from becoming two operators of one mailbox.
     */
    check('users_email_lowercase', sql`${table.email} = lower(${table.email})`),
  ],
).enableRLS()

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_key').on(table.token),
    index('sessions_user_id_idx').on(table.userId),
  ],
).enableRLS()

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('accounts_user_id_idx').on(table.userId)],
).enableRLS()

/** One-time sign-in codes (FR-018) live here until used or expired. */
export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
).enableRLS()

/**
 * `owner` is the only role that may confirm an emergency key replacement
 * (FR-027); `operator` reads the journal and the decisions (FR-016, FR-017).
 */
export const memberRole = pgEnum('member_role', ['owner', 'operator'])

/**
 * Access to a project is a row here and nothing else (FR-018): a session
 * proves who the user is, this table says which projects they see.
 */
export const members = pgTable(
  'members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    /** The primary key starts with the project; "my projects" starts with the user. */
    index('members_user_id_idx').on(table.userId),
  ],
).enableRLS()
