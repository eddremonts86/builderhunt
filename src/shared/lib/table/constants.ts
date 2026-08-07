/**
 * The one page size.
 *
 * Every list read that feeds a table asks for this many rows. It lives alone in its own module so
 * that changing it is one edit and one deploy, rather than a search for the routes that happened
 * to literal 30, 50 or 100 — the state phase 3 found the app in.
 *
 * A client may ask for fewer. A client asking for more is clamped, not honoured: page size is a
 * property of what the server is willing to serve, not of what the caller would like.
 */
export const TABLE_PAGE_SIZE = 50
