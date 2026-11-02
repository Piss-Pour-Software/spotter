// The site: one page, and /install pointing at this release's script in the public repository, so what runs is what anyone
// can read. It holds no secret and no binding, and it reaches none of our machines: it answers only from what it was built
// with. /download/ never comes here: those are the release's files, which Cloudflare serves itself (static assets).

// The build fills this line: the page with its source header, the hashes of the page's own style blocks, and the release's
// install.sh at its tag, never main, so what /install runs and the files it names are one release.
const SITE = { page: "", styles: [], install: "" };

const COMMON = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

const notFound = () => new Response("Not found\n", { status: 404, headers: { ...COMMON, "content-type": "text/plain; charset=utf-8" } });

export function respond(pathname, method, site = SITE) {
  if (method !== "GET" && method !== "HEAD") return notFound();
  if (pathname === "/") {
    const styles = site.styles.map((hash) => `'${hash}'`).join(" ") || "'none'";
    const policy = `default-src 'none'; style-src ${styles}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    return new Response(site.page, { headers: { ...COMMON, "content-type": "text/html; charset=utf-8", "content-security-policy": policy, "cache-control": "public, max-age=300" } });
  }
  if (pathname === "/install" && site.install) return new Response(null, { status: 302, headers: { ...COMMON, location: site.install, "cache-control": "no-store" } });
  return notFound();
}

export default { fetch: (request) => respond(new URL(request.url).pathname, request.method) };
