/**
 * Search engines. By default the public pages (landing, pricing, status, docs) may be indexed and the dashboards
 * and API are disallowed. A deployment that must not be discoverable sets SEARCH_INDEXING=off (runtime): robots.txt
 * then disallows everything and server.mjs adds `X-Robots-Tag: noindex, nofollow, noarchive` to every page.
 */
export const searchIndexingAllowed = (): boolean => !/^(off|false|0|no)$/i.test(process.env.SEARCH_INDEXING ?? "");
