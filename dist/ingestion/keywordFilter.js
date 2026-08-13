import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
let db;
export async function initDatabase() {
    db = await open({
        filename: path.resolve('./articles.sqlite'),
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS processed_articles (
            id TEXT PRIMARY KEY,
            title TEXT,
            link TEXT,
            pubDate TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
}
export async function isArticleProcessed(id) {
    const row = await db.get('SELECT id FROM processed_articles WHERE id = ?', [id]);
    return !!row;
}
export async function markArticleProcessed(id, title, link, pubDate) {
    await db.run('INSERT OR IGNORE INTO processed_articles (id, title, link, pubDate) VALUES (?, ?, ?, ?)', [id, title, link, pubDate]);
}
