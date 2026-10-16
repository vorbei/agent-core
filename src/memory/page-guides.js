// Page guides: short, verified notes about one site's page (how its search form's date filter
// works, say) that reach the model only while the browser is on that page. An app guide is a page
// guide that also names the apps it is about (`apps`, bundle ids): it belongs to a page that shows a
// phone, and reaches the model only while one of those apps is in front there. Selection only; the
// guides themselves (prose) are the consumer's data, and so is knowing which app is in front.

/** @typedef {import("./index.js").GuideDomain} GuideDomain */
/** @typedef {import("./index.js").PageGuide} PageGuide */

/** Whether a path prefix covers a pathname ("/search" covers "/search" and "/search/advanced"). @param {string} prefix @param {string} pathname */
export function pathCovers(prefix, pathname) {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

/**
 * The bundled guide for a URL's page, or null: among the page guides of the first domain that
 * names the URL's host (or a parent domain of it), the one with the longest path covering the
 * URL's path, so a page's own guide wins over a site-wide one ("/"). App guides are left out.
 * @param {GuideDomain[]} domains @param {string} url @returns {PageGuide | null}
 */
export function bundledPageGuide(domains, url) {
  return select(domains, url, (page) => !page.apps);
}

/**
 * The bundled app guide for the app in front on a URL's page, or null: chosen as a page guide is,
 * among the guides that name that app's bundle id.
 * @param {GuideDomain[]} domains @param {string} url @param {string | null | undefined} app bundle id @returns {PageGuide | null}
 */
export function bundledAppGuide(domains, url, app) {
  if (!app) return null;
  const guide = select(domains, url, (page) => Boolean(page.apps?.includes(app)));
  return guide && { ...guide, app };
}

/** @param {GuideDomain[]} domains @param {string} url @param {(page: GuideDomain["pages"][number]) => boolean} eligible */
function select(domains, url, eligible) {
  let location;
  try { location = new URL(url); } catch { return null; }
  const host = location.hostname;
  for (const domain of domains) {
    if (!(domain.domains || []).some(entry => host === entry || host.endsWith("." + entry))) continue;
    let best = null;
    for (const page of (domain.pages || []).filter(eligible)) for (const path of page.paths) {
      if (pathCovers(path, location.pathname) && (!best || path.length > best.path.length)) best = { page, path };
    }
    if (best) {
      return { id: `bundled:${best.page.name}`, source: "bundled", host, pathPrefix: best.path,
        content: best.page.content.trim(), since: best.page.verifiedOn || null };
    }
  }
  return null;
}
