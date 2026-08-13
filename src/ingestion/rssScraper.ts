import Parser from 'rss-parser';
import { isArticleProcessed, markArticleProcessed } from '../persistence/db.js';

const parser = new Parser();

export interface ScrapedArticle {
    id: string;
    title: string;
    link: string;
    pubDate: string;
    content: string;
}

// One Google News request per keyword per loop at most.
const feedCache = new Map<string, { at: number; articles: ScrapedArticle[] }>();
const FEED_CACHE_TTL_MS = 4 * 60 * 1000;

/**
 * Fetches unseen news articles for a keyword.
 *
 * NOTE: articles are NOT marked as processed here. Call
 * commitArticles(articles) after the market evaluation has actually
 * consumed them — otherwise a failed evaluation burns the news forever.
 */
export async function scrapeNews(keyword: string): Promise<ScrapedArticle[]> {
    const cached = feedCache.get(keyword);
    if (cached && Date.now() - cached.at < FEED_CACHE_TTL_MS) {
        return cached.articles;
    }

    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=en-US&gl=US&ceid=US:en`;
    const newArticles: ScrapedArticle[] = [];

    try {
        const feed = await parser.parseURL(url);

        for (const item of feed.items) {
            const id = item.guid || item.link;
            if (!id) continue;

            const isProcessed = await isArticleProcessed(id);
            if (!isProcessed) {
                newArticles.push({
                    id,
                    title: item.title || '',
                    link: item.link || '',
                    pubDate: item.pubDate || new Date().toISOString(),
                    content: item.contentSnippet || item.content || item.title || ''
                });
            }
        }
    } catch (error) {
        console.error(`Error scraping news for keyword "${keyword}":`, error);
    }

    feedCache.set(keyword, { at: Date.now(), articles: newArticles });
    return newArticles;
}

/** Mark articles as consumed — call only after a successful evaluation. */
export async function commitArticles(articles: ScrapedArticle[]) {
    for (const a of articles) {
        await markArticleProcessed(a.id, a.title, a.link, a.pubDate);
    }
}
