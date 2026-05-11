const PUBLIC_PAGE_PREFIXES = ["/login", "/docs", "/landing"];

function matchesRoutePrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGE_PREFIXES.some((prefix) => matchesRoutePrefix(pathname, prefix));
}
