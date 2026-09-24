/** True only in the clickable demo build (`npm run build:demo`), which answers API calls from sample data in the browser. */
export const DEMO = import.meta.env.MODE === 'demo';
