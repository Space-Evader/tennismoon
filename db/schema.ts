import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const goals = sqliteTable('goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  target: text('target').notNull(),
  progress: integer('progress').notNull().default(0),
  streak: integer('streak').notNull().default(0),
  dueDate: text('due_date'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

