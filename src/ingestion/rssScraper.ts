import Parser from 'rss-parser';
import { isArticleProcessed, markArticleProcessed } from './keywordFilter';

const parser = new Parser();

export interface ScrapedArticle {
    title: string;
    link: string;
    pubDate: string;
    content: string;
}

export async function scrapeNews(keyword: string): Promise<ScrapedArticle[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=en-US&gl=US&ceid=US:en`;
    const newArticles: ScrapedArticle[] = [];

    try {
        const feed = await parser.parseURL(url);
        
        for (const item of feed.items) {
            const id = item.guid || item.link;
            if (!id) continue;

            const isProcessed = await isArticleProcessed(id);
            if (!isProcessed) {
                const article: ScrapedArticle = {
                    title: item.title || '',
                    link: item.link || '',
                    pubDate: item.pubDate || new Date().toISOString(),
                    content: item.contentSnippet || item.content || item.title || ''
                };
                
                newArticles.push(article);
                await markArticleProcessed(id, article.title, article.link, article.pubDate);
            }
        }
    } catch (error) {
        console.error(`Error scraping news for keyword "${keyword}":`, error);
    }

    return newArticles;
}
